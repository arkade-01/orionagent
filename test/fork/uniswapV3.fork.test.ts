import type { ChildProcess } from "node:child_process";
import { parseAbiItem, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi } from "../../src/abis/erc20.js";
import { nonfungiblePositionManagerAbi as npmAbi } from "../../src/abis/nonfungiblePositionManager.js";
import { UniswapV3Adapter } from "../../src/adapters/uniswapV3.js";
import { ADDRESSES, UINT128_MAX } from "../../src/config.js";
import { clearTokenCache } from "../../src/tokens.js";
import type { ScanContext } from "../../src/types.js";
import {
  forkClients,
  forkRpcUrl,
  fundedImpersonation,
  skipWithReason,
  startAnvil,
  widenUntilFound,
} from "./anvil.js";

const NPM = ADDRESSES.uniswapV3PositionManager;
const hasFork = forkRpcUrl() !== null;
let anvil: ChildProcess | null = null;

/** Walk recent liquidity events for a position that actually owes fees. */
async function findOwedPosition(): Promise<{ owner: Address; tokenId: bigint } | null> {
  const { public: client } = forkClients();
  const head = await client.getBlockNumber();
  return widenUntilFound([500n, 2000n, 6000n], (span) => searchWindow(client, head - span, head));
}

async function searchWindow(
  client: ReturnType<typeof forkClients>["public"],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ owner: Address; tokenId: bigint } | null> {
  const logs = await client.getLogs({
    address: NPM,
    event: parseAbiItem(
      "event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    ),
    fromBlock,
    toBlock,
  });

  const ids = [...new Set(logs.map((l) => (l.args as { tokenId: bigint }).tokenId))].slice(0, 60);
  const owners = await client.multicall({
    contracts: ids.map((tokenId) => ({
      address: NPM,
      abi: npmAbi,
      functionName: "ownerOf" as const,
      args: [tokenId] as const,
    })),
    allowFailure: true,
  });

  for (const [i, res] of owners.entries()) {
    if (res.status !== "success") continue;
    const owner = res.result as Address;
    const tokenId = ids[i]!;
    try {
      const { result } = await client.simulateContract({
        address: NPM,
        abi: npmAbi,
        functionName: "collect",
        args: [{ tokenId, recipient: owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
        account: owner,
      });
      const [a0, a1] = result as readonly [bigint, bigint];
      if (a0 > 0n || a1 > 0n) return { owner, tokenId };
    } catch {
      continue;
    }
  }
  return null;
}

describe.skipIf(!hasFork)("uniswap v3 (Base fork)", () => {
  let target: { owner: Address; tokenId: bigint } | null = null;
  let unavailable: string | null = null;

  beforeAll(async () => {
    anvil = await startAnvil();
    if (!anvil) {
      unavailable = "anvil could not be started";
      return;
    }
    clearTokenCache();
    try {
      target = await findOwedPosition();
      if (!target) unavailable = "no recent position with uncollected fees";
    } catch (err) {
      unavailable = `target discovery failed: ${(err as Error).message.split("\n")[0]}`;
    }
  }, 240_000);

  afterAll(() => anvil?.kill());

  it("static-call collect equals what a real collect transfers", async (t) => {
    if (!target) return skipWithReason(t, unavailable ?? "no target");
    const { owner, tokenId } = target;
    const { public: client, wallet } = forkClients();

    const position = (await client.readContract({
      address: NPM,
      abi: npmAbi,
      functionName: "positions",
      args: [tokenId],
    })) as readonly unknown[];
    const token0 = position[2] as Address;
    const token1 = position[3] as Address;
    const staleOwed0 = position[10] as bigint;
    const staleOwed1 = position[11] as bigint;

    const { result } = await client.simulateContract({
      address: NPM,
      abi: npmAbi,
      functionName: "collect",
      args: [{ tokenId, recipient: owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
      account: owner,
    });
    const [predicted0, predicted1] = result as readonly [bigint, bigint];

    const balance = async (token: Address) =>
      (await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
      })) as bigint;

    const before0 = await balance(token0);
    const before1 = await balance(token1);

    await fundedImpersonation(owner);
    const hash = await wallet.writeContract({
      account: owner,
      chain: null,
      address: NPM,
      abi: npmAbi,
      functionName: "collect",
      args: [{ tokenId, recipient: owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX }],
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");

    expect((await balance(token0)) - before0).toBe(predicted0);
    expect((await balance(token1)) - before1).toBe(predicted1);

    // The reason we static-call rather than read tokensOwed: the stored value
    // only refreshes when the position is touched, so it under-reports.
    expect(staleOwed0).toBeLessThanOrEqual(predicted0);
    expect(staleOwed1).toBeLessThanOrEqual(predicted1);
  }, 240_000);

  it("the adapter reports and then collects the same amounts", async (t) => {
    if (!target) return skipWithReason(t, unavailable ?? "no target");
    const { public: client, wallet } = forkClients();
    const ctx: ScanContext = {
      owner: target.owner,
      chainId: 8453,
      blockNumber: await client.getBlockNumber(),
    };

    const adapter = new UniswapV3Adapter(client);
    const { items } = await adapter.scan(ctx);
    const mine = items.filter((i) => i.meta?.tokenId === target!.tokenId.toString());
    if (mine.length === 0) return skipWithReason(t, "position no longer owes fees");

    expect(mine.every((i) => i.claimType === "owner-sign")).toBe(true);

    const balance = async (token: Address) =>
      (await client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [ctx.owner],
      })) as bigint;
    const before = new Map(await Promise.all(mine.map(async (i) => [i.token.address, await balance(i.token.address)] as const)));

    const txs = await adapter.buildClaim(ctx, mine);
    // One collect per position, not one per token leg.
    expect(txs).toHaveLength(1);

    await fundedImpersonation(ctx.owner);
    const hash = await wallet.sendTransaction({
      account: ctx.owner,
      chain: null,
      to: txs[0]!.to,
      data: txs[0]!.data,
      value: txs[0]!.value,
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");

    for (const item of mine) {
      const delta = (await balance(item.token.address)) - (before.get(item.token.address) ?? 0n);
      expect(delta).toBe(item.rawAmount);
    }
  }, 240_000);
});
