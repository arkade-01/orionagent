import { getAddress, parseAbiItem, type Address, type PublicClient } from "viem";
import { nonfungiblePositionManagerAbi as npmAbi } from "../abis/nonfungiblePositionManager.js";
import { ADDRESSES, LOG_WINDOW_BLOCKS, UINT128_MAX } from "../config.js";
import { summarizeError } from "../errors.js";
import { loadTokenInfo } from "../tokens.js";
import type { ScanContext, SourceNote, UnreachableValue } from "../types.js";

const NPM = ADDRESSES.uniswapV3PositionManager;

const TRANSFER = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

/** Ownership accessors that per-user vaults and Safes commonly expose. */
const ownerAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const safeAbi = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
] as const;

export interface FindMovedOptions {
  /** How far back to look for outbound transfers. Base is ~2s/block. */
  lookbackBlocks?: bigint;
  concurrency?: number;
}

/**
 * Find Uniswap v3 positions this wallet transferred away that still owe fees.
 *
 * Measured on Base, ~45% of live positions are held by contracts rather than
 * EOAs, and most of those holders are per-user (a Safe, a personal vault, an
 * automation contract) rather than pooled. So this is real money that a
 * wallet-only scan cannot see.
 *
 * What it will NOT do is call these claimable. `collect` must be sent by the
 * NFT's holder, and whether a given contract exposes a path to do that is
 * contract-specific — so we cannot build a transaction that works. Reporting
 * them as claimable would promise money the tool cannot produce. They come back
 * as `UnreachableValue`, excluded from every total, with the holder named so
 * the owner knows where to go.
 *
 * `owner()` matching the scanned address is a strong hint, not proof of a claim
 * path, and is labelled as such.
 */
export async function findMovedPositions(
  client: PublicClient,
  ctx: ScanContext,
  scannedOwners: Address[],
  options: FindMovedOptions = {},
): Promise<{ unreachable: UnreachableValue[]; notes: SourceNote[] }> {
  const notes: SourceNote[] = [];
  const lookback = options.lookbackBlocks ?? 500_000n; // ~11 days
  const fromBlock = ctx.blockNumber > lookback ? ctx.blockNumber - lookback : 0n;

  const windows: { from: bigint; to: bigint }[] = [];
  for (let f = fromBlock; f <= ctx.blockNumber; f += LOG_WINDOW_BLOCKS) {
    const to = f + LOG_WINDOW_BLOCKS - 1n;
    windows.push({ from: f, to: to > ctx.blockNumber ? ctx.blockNumber : to });
  }

  const sent = new Set<bigint>();
  let failed = 0;
  let failureSample: string | undefined;

  const queue = [...windows];
  await Promise.all(
    Array.from({ length: Math.min(options.concurrency ?? 10, queue.length) }, async () => {
      for (;;) {
        const w = queue.pop();
        if (!w) return;
        try {
          const logs = await client.getLogs({
            address: NPM,
            event: TRANSFER,
            args: { from: ctx.owner },
            fromBlock: w.from,
            toBlock: w.to,
          });
          for (const log of logs) {
            const id = (log.args as { tokenId?: bigint }).tokenId;
            if (id !== undefined) sent.add(id);
          }
        } catch (err) {
          failed++;
          failureSample ??= summarizeError(err);
        }
      }
    }),
  );

  if (failed > 0) {
    notes.push({
      source: "uniswap-v3",
      message:
        `Moved-position search INCOMPLETE: ${failed} of ${windows.length} block windows could not ` +
        `be read${failureSample ? ` (${failureSample})` : ""}. Positions moved during those ranges ` +
        `are missing from this list.`,
    });
  }

  if (sent.size === 0) {
    notes.push({
      source: "uniswap-v3",
      message:
        `No Uniswap positions were transferred out of ${ctx.owner} in the last ${lookback} blocks. ` +
        `Anything moved before that window is outside this search.`,
    });
    return { unreachable: [], notes };
  }

  const tokenIds = [...sent];
  const [owners, positions] = await Promise.all([
    client.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: NPM,
        abi: npmAbi,
        functionName: "ownerOf" as const,
        args: [tokenId] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    }),
    client.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: NPM,
        abi: npmAbi,
        functionName: "positions" as const,
        args: [tokenId] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    }),
  ]);

  const scanned = new Set(scannedOwners.map((a) => a.toLowerCase()));
  const unreachable: UnreachableValue[] = [];

  for (const [i, tokenId] of tokenIds.entries()) {
    const ownerResult = owners[i];
    const positionResult = positions[i];
    if (ownerResult?.status !== "success" || positionResult?.status !== "success") continue;

    const holder = getAddress(ownerResult.result as string);
    // Back in our hands, or in another address we already scanned: not unreachable.
    if (scanned.has(holder.toLowerCase())) continue;

    // Static-call collect AS THE HOLDER — the same read a claimable item uses,
    // just from the address that is actually allowed to make it.
    let amount0 = 0n;
    let amount1 = 0n;
    try {
      const { result } = await client.simulateContract({
        address: NPM,
        abi: npmAbi,
        functionName: "collect",
        args: [{ tokenId, recipient: holder, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
        account: holder,
        blockNumber: ctx.blockNumber,
      });
      [amount0, amount1] = result as readonly [bigint, bigint];
    } catch {
      continue; // Unreadable: report nothing rather than speculate.
    }
    if (amount0 === 0n && amount1 === 0n) continue;

    const p = positionResult.result as readonly unknown[];
    const token0 = getAddress(p[2] as string);
    const token1 = getAddress(p[3] as string);

    const holderOwner = await resolveHolderOwner(client, holder, ctx.blockNumber);
    const looksControlled = holderOwner !== null && scanned.has(holderOwner.toLowerCase());

    const info = await loadTokenInfo(client, [token0, token1], ctx.blockNumber);
    const amounts = [
      { address: token0, rawAmount: amount0 },
      { address: token1, rawAmount: amount1 },
    ]
      .filter((a) => a.rawAmount > 0n)
      .map((a) => ({
        token: info.get(a.address.toLowerCase()) ?? {
          address: a.address,
          symbol: null,
          name: null,
          decimals: 18,
        },
        rawAmount: a.rawAmount,
        usdValue: null as number | null, // priced by the engine, like every other amount
      }));

    unreachable.push({
      source: "uniswap-v3",
      holder,
      holderOwner,
      looksControlledByOwner: looksControlled,
      label:
        `Uniswap v3 position #${tokenId} was moved out of ${ctx.owner} and is held by ${holder}` +
        (looksControlled
          ? `, which reports ${holderOwner} as its owner. The fees are almost certainly yours, but ` +
            `they must be collected through that contract — this tool cannot build that transaction.`
          : `. Only that contract can collect these fees; they may not be yours.`),
      amounts,
      provenance: [
        {
          kind: "contract-read",
          target: NPM,
          call: "ownerOf(uint256)",
          args: [tokenId.toString()],
          result: holder,
          blockNumber: ctx.blockNumber,
          fetchedAt: new Date().toISOString(),
        },
        {
          kind: "contract-static-call",
          target: NPM,
          call: "collect((uint256,address,uint128,uint128)) [eth_call as the holder]",
          args: [tokenId.toString(), holder],
          result: JSON.stringify({ amount0: amount0.toString(), amount1: amount1.toString() }),
          blockNumber: ctx.blockNumber,
          fetchedAt: new Date().toISOString(),
        },
      ],
    });
  }

  return { unreachable, notes };
}

/** Best-effort: what does this holder say its owner is? */
async function resolveHolderOwner(
  client: PublicClient,
  holder: Address,
  blockNumber: bigint,
): Promise<Address | null> {
  try {
    return getAddress(
      (await client.readContract({
        address: holder,
        abi: ownerAbi,
        functionName: "owner",
        blockNumber,
      })) as string,
    );
  } catch {
    // Not an Ownable. Try Safe, and only when it has exactly one owner — a
    // multisig's first signer is not "the owner" in any meaningful sense.
    try {
      const owners = (await client.readContract({
        address: holder,
        abi: safeAbi,
        functionName: "getOwners",
        blockNumber,
      })) as readonly string[];
      return owners.length === 1 ? getAddress(owners[0]!) : null;
    } catch {
      return null;
    }
  }
}
