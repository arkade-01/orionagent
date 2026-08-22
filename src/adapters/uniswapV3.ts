import { encodeFunctionData, getAddress, type Address, type PublicClient } from "viem";
import { nonfungiblePositionManagerAbi as npmAbi } from "../abis/nonfungiblePositionManager.js";
import { ADDRESSES, UINT128_MAX } from "../config.js";
import { contractRead, staticCall } from "../provenance.js";
import { loadTokenInfo } from "../tokens.js";
import type { ClaimTx, ScanContext, SourceAdapter, SourceNote, UnclaimedItem } from "../types.js";

interface OwedPosition {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  fee: number;
  amount0: bigint;
  amount1: bigint;
}

const NPM = ADDRESSES.uniswapV3PositionManager;

/**
 * Uncollected Uniswap v3 LP fees.
 *
 * Owed amounts come from static-calling `collect` with uint128-max maximums —
 * that runs the same accounting a real collect would, at the pinned block.
 * `positions().tokensOwed0/1` is deliberately NOT used for amounts: it only
 * refreshes when the position is touched, so it under-reports on any position
 * that has been earning since its last poke. We read `positions` only for the
 * token pair and fee tier.
 *
 * Claim type is owner-sign: `collect` is gated on the caller being the position
 * owner or an approved operator, so the agent builds the tx and the owner signs.
 */
export class UniswapV3Adapter implements SourceAdapter {
  readonly id = "uniswap-v3" as const;
  readonly claimType = "owner-sign" as const;

  constructor(private readonly client: PublicClient) {}

  private async listTokenIds(ctx: ScanContext): Promise<bigint[]> {
    const balance = (await this.client.readContract({
      address: NPM,
      abi: npmAbi,
      functionName: "balanceOf",
      args: [ctx.owner],
      blockNumber: ctx.blockNumber,
    })) as bigint;

    if (balance === 0n) return [];

    const results = await this.client.multicall({
      contracts: Array.from({ length: Number(balance) }, (_, i) => ({
        address: NPM,
        abi: npmAbi,
        functionName: "tokenOfOwnerByIndex" as const,
        args: [ctx.owner, BigInt(i)] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });

    return results.flatMap((r) => (r.status === "success" ? [r.result as bigint] : []));
  }

  private async readOwed(ctx: ScanContext, tokenIds: bigint[]): Promise<OwedPosition[]> {
    const positions = await this.client.multicall({
      contracts: tokenIds.map((tokenId) => ({
        address: NPM,
        abi: npmAbi,
        functionName: "positions" as const,
        args: [tokenId] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });

    const owed: OwedPosition[] = [];
    for (const [i, tokenId] of tokenIds.entries()) {
      const pos = positions[i];
      if (!pos || pos.status !== "success") continue;
      const p = pos.result as readonly unknown[];
      const token0 = getAddress(p[2] as string);
      const token1 = getAddress(p[3] as string);
      const fee = Number(p[4]);

      // Static call as the owner: `collect` reverts for anyone else.
      let amount0 = 0n;
      let amount1 = 0n;
      try {
        const { result } = await this.client.simulateContract({
          address: NPM,
          abi: npmAbi,
          functionName: "collect",
          args: [
            { tokenId, recipient: ctx.owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX },
          ],
          account: ctx.owner,
          blockNumber: ctx.blockNumber,
        });
        [amount0, amount1] = result as readonly [bigint, bigint];
      } catch {
        continue; // Unreadable position: report nothing rather than estimate.
      }

      if (amount0 > 0n || amount1 > 0n) {
        owed.push({ tokenId, token0, token1, fee, amount0, amount1 });
      }
    }
    return owed;
  }

  async scan(ctx: ScanContext): Promise<{ items: UnclaimedItem[]; notes?: SourceNote[] }> {
    // Stated on every scan, including empty ones — "no LP fees" is exactly the
    // answer a reader would otherwise take as complete.
    //
    // `balanceOf`/`tokenOfOwnerByIndex` see positions this address holds. A
    // position transferred to a Safe, a personal vault, or an automation
    // contract is owned by that contract, and `collect` would have to be called
    // BY it — so those fees are real but not claimable from here, and are
    // deliberately not listed as if they were.
    //
    // Note this does NOT affect EIP-7702 smart accounts: those keep the wallet's
    // own address, so their positions show up normally.
    const scopeNote: SourceNote = {
      source: this.id,
      message:
        "Covers Uniswap v3 positions held directly by this address. Positions moved to a Safe, " +
        "a personal vault, or an automation contract belong to that contract and are not " +
        "included — pass those addresses with --also to scan them too.",
    };

    const tokenIds = await this.listTokenIds(ctx);
    if (tokenIds.length === 0) return { items: [], notes: [scopeNote] };

    const owed = await this.readOwed(ctx, tokenIds);
    if (owed.length === 0) return { items: [], notes: [scopeNote] };

    const tokenInfo = await loadTokenInfo(
      this.client,
      owed.flatMap((o) => [o.token0, o.token1]),
      ctx.blockNumber,
    );

    const items: UnclaimedItem[] = [];
    for (const pos of owed) {
      const legs = [
        { address: pos.token0, amount: pos.amount0, index: 0 },
        { address: pos.token1, amount: pos.amount1, index: 1 },
      ];
      for (const leg of legs) {
        if (leg.amount <= 0n) continue;
        const info = tokenInfo.get(leg.address.toLowerCase());
        items.push({
          id: `uniswap-v3:${pos.tokenId}:${leg.index}`,
          source: this.id,
          owner: ctx.owner,
          token: info ?? { address: leg.address, symbol: null, name: null, decimals: 18 },
          rawAmount: leg.amount,
          usdValue: null,
          claimType: this.claimType,
          label: `Uniswap v3 LP fees — position #${pos.tokenId} (${pos.fee / 10000}% tier)`,
          provenance: [
            contractRead({
              target: NPM,
              call: "positions(uint256)",
              args: [pos.tokenId],
              result: { token0: pos.token0, token1: pos.token1, fee: pos.fee },
              blockNumber: ctx.blockNumber,
            }),
            staticCall({
              target: NPM,
              call: "collect((uint256,address,uint128,uint128)) [eth_call, amountMax = uint128 max]",
              args: [
                { tokenId: pos.tokenId, recipient: ctx.owner, amount0Max: UINT128_MAX, amount1Max: UINT128_MAX },
              ],
              result: { amount0: pos.amount0, amount1: pos.amount1 },
              blockNumber: ctx.blockNumber,
            }),
          ],
          meta: { tokenId: pos.tokenId.toString(), legIndex: leg.index, feeTier: pos.fee },
        });
      }
    }

    return { items, notes: [scopeNote] };
  }

  async buildClaim(ctx: ScanContext, items: UnclaimedItem[]): Promise<ClaimTx[]> {
    // Both legs of a position settle in one `collect`, so dedupe by tokenId.
    const tokenIds = [
      ...new Set(
        items
          .filter((i) => i.source === this.id)
          .map((i) => String((i.meta as { tokenId?: string } | undefined)?.tokenId ?? "")),
      ),
    ].filter(Boolean);

    return tokenIds.map((tokenId) => ({
      to: NPM,
      data: encodeFunctionData({
        abi: npmAbi,
        functionName: "collect",
        args: [
          {
            tokenId: BigInt(tokenId),
            recipient: ctx.owner, // always the owner, never the agent
            amount0Max: UINT128_MAX,
            amount1Max: UINT128_MAX,
          },
        ],
      }),
      value: 0n,
      chainId: ctx.chainId,
      claimType: this.claimType,
      description: `Collect Uniswap v3 fees for position #${tokenId} -> ${ctx.owner}`,
      itemIds: items
        .filter((i) => (i.meta as { tokenId?: string } | undefined)?.tokenId === tokenId)
        .map((i) => i.id),
    }));
  }
}
