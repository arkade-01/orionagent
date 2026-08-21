import { encodeFunctionData, getAddress, zeroAddress, type Address, type PublicClient } from "viem";
import { merklDistributorAbi } from "../abis/merklDistributor.js";
import { merklTokenWrapperAbi } from "../abis/merklTokenWrapper.js";
import { ADDRESSES, API, BASE_CHAIN_ID } from "../config.js";
import { contractRead, httpRead } from "../provenance.js";
import { loadTokenInfo } from "../tokens.js";
import type {
  ClaimType,
  ClaimTx,
  ScanContext,
  SourceAdapter,
  SourceNote,
  UnclaimedItem,
} from "../types.js";

/** Shape of `GET /v4/users/{address}/rewards?chainId=8453`. */
interface MerklRewardToken {
  chainId: number;
  address: Address;
  symbol?: string;
  name?: string;
  decimals?: number;
}

interface MerklReward {
  root: `0x${string}`;
  distributionChainId?: number;
  recipient: Address;
  /** CUMULATIVE lifetime entitlement, base units. Not the claimable delta. */
  amount: string;
  /** Cumulative already claimed, base units. */
  claimed: string;
  pending?: string;
  proofs: `0x${string}`[];
  token: MerklRewardToken;
}

interface MerklChainRewards {
  chain: { id: number };
  rewards: MerklReward[];
}

/** One Merkl entry from the API, before on-chain reconciliation. */
export interface MerklClaimable {
  token: MerklRewardToken;
  /** Cumulative lifetime entitlement — what `claim` expects as `amounts[i]`. */
  cumulativeAmount: bigint;
  /** What the API believes has been claimed. Indicative only; see below. */
  claimedAmount: bigint;
  /** cumulative - claimed, per the API. Refined by `reconcile`. */
  claimableAmount: bigint;
  proofs: `0x${string}`[];
  root: `0x${string}`;
}

/** A Merkl entry after checking the Distributor's own state. */
export interface MerklSettled extends MerklClaimable {
  /** `claimed[user][token].amount` — the figure the contract actually uses. */
  onChainClaimed: bigint;
  /** cumulative - onChainClaimed. The real transfer a claim produces. */
  settledAmount: bigint;
  /** Where the tokens land. Usually the owner; not always — see `claimRecipient`. */
  recipient: Address;
  /**
   * The token the owner actually ends up holding. Differs from `token` when the
   * campaign distributes a Merkl wrapper that unwraps 1:1 on receipt.
   */
  underlying: Address | null;
}

function rewardsUrl(owner: Address): string {
  return `${API.merkl}/v4/users/${owner}/rewards?chainId=${BASE_CHAIN_ID}`;
}

/**
 * Fetch + filter the API's view. Entries that would revert the whole `claim` tx
 * are dropped here, in one place, so scan and buildClaim can never disagree:
 *  - `amount === claimed` -> nothing left; the distributor reverts.
 *  - empty `proofs` -> `InvalidProof`, and it takes the whole batch down with it.
 *
 * The `claimed` figure here is the API's, which can lag the chain. `reconcile`
 * replaces it with the contract's before any amount is reported or encoded.
 */
export async function fetchMerklClaimables(
  owner: Address,
  fetchImpl: typeof fetch = fetch,
): Promise<{ claimables: MerklClaimable[]; raw: unknown; url: string }> {
  const url = rewardsUrl(owner);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Merkl API ${res.status} for ${owner}`);
  const raw = (await res.json()) as MerklChainRewards[];

  const claimables: MerklClaimable[] = [];
  for (const chain of raw ?? []) {
    if (chain.chain?.id !== BASE_CHAIN_ID) continue;
    for (const reward of chain.rewards ?? []) {
      const cumulativeAmount = BigInt(reward.amount ?? "0");
      const claimedAmount = BigInt(reward.claimed ?? "0");
      const claimableAmount = cumulativeAmount - claimedAmount;
      if (claimableAmount <= 0n) continue;
      if (!reward.proofs || reward.proofs.length === 0) continue;
      claimables.push({
        token: reward.token,
        cumulativeAmount,
        claimedAmount,
        claimableAmount,
        proofs: reward.proofs,
        root: reward.root,
      });
    }
  }
  return { claimables, raw, url };
}

/**
 * Merkl incentives.
 *
 * CLAIM TYPE IS `owner-sign` BY DEFAULT, and that is a correction to the spec.
 * `claim` credits `users[i]` rather than msg.sender, which looks permissionless,
 * but the verified Distributor source reverts `NotWhitelisted()` unless the
 * caller is the user, is `tx.origin`, or has been approved as an operator. See
 * src/abis/merklDistributor.ts for the exact condition.
 *
 * It becomes `permissionless` for a given owner only once that owner has run
 * `toggleOperator(owner, agent)`; pass the agent address via `agentAddress` and
 * the adapter checks the approval on-chain rather than assuming either way.
 *
 * Proofs live under a merkle root that Merkl rotates roughly every 4 hours, so
 * `buildClaim` refetches instead of reusing anything `scan` saw. Nothing from a
 * scan is ever encoded into a tx.
 */
export class MerklAdapter implements SourceAdapter {
  readonly id = "merkl" as const;
  /** The conservative default. `scan` upgrades per-item when approval exists. */
  readonly claimType = "owner-sign" as const;

  constructor(
    private readonly client: PublicClient,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Agent signer, when one is configured. Only used to check operator approval. */
    private readonly agentAddress?: Address,
  ) {}

  /**
   * Can `agentAddress` submit this owner's claim? Checks the two operator
   * mappings the Distributor consults. Any read failure means "assume not" —
   * a wrongly-optimistic claim type produces a tx that reverts.
   */
  private async agentCanClaimFor(owner: Address, tokens: Address[]): Promise<boolean> {
    const agent = this.agentAddress;
    if (!agent) return false;
    try {
      const [userApprovals, mainApprovals] = await Promise.all([
        // operators[owner][x] — the owner approving a specific agent, or everyone.
        this.client.multicall({
          contracts: [agent, zeroAddress].map((operator) => ({
            address: ADDRESSES.merklDistributor,
            abi: merklDistributorAbi,
            functionName: "operators" as const,
            args: [owner, operator] as const,
          })),
          allowFailure: true,
        }),
        // mainOperators[agent][token] — a protocol-level operator, per token or
        // globally via the zero address.
        this.client.multicall({
          contracts: [...tokens, zeroAddress].map((token) => ({
            address: ADDRESSES.merklDistributor,
            abi: merklDistributorAbi,
            functionName: "mainOperators" as const,
            args: [agent, token] as const,
          })),
          allowFailure: true,
        }),
      ]);

      const truthy = (r: { status: string; result?: unknown } | undefined) =>
        r?.status === "success" && (r.result as bigint) !== 0n;

      if (userApprovals.some(truthy)) return true;
      // A per-token main-operator flag must cover EVERY token in the batch —
      // one uncovered token reverts the whole claim.
      const globalMain = mainApprovals[mainApprovals.length - 1];
      if (truthy(globalMain)) return true;
      const perToken = mainApprovals.slice(0, -1);
      return perToken.length > 0 && perToken.every(truthy);
    } catch {
      return false;
    }
  }

  /**
   * Replace the API's `claimed` with the Distributor's own, and find out where
   * the tokens would actually go.
   *
   * The contract computes `toSend = amount - claimed[user][token].amount` from
   * its own storage. The API's `claimed` is an index that can lag it — most
   * visibly in the minutes after a claim, when the API may still advertise an
   * entitlement the chain has already paid out. Trusting it produced a report
   * promising tokens that a claim then delivered zero of.
   *
   * `claimRecipient` matters for the same reason: a user can redirect their
   * rewards, in which case the claim does NOT land in their wallet, and the
   * report must not say it does.
   */
  /**
   * Resolve Merkl wrapper tokens to what the wallet actually receives.
   *
   * A contract is treated as a wrapper only when it exposes `token()` AND its
   * `distributor()` is the Merkl Distributor — `token()` alone is a common
   * enough view that matching on it would remap unrelated tokens. The remap is
   * also skipped when decimals differ, since then the amounts are not 1:1 and
   * reinterpreting one as the other would change what the number means.
   */
  private async resolveUnderlying(tokens: Address[]): Promise<Map<string, Address>> {
    const out = new Map<string, Address>();
    if (tokens.length === 0) return out;

    const probe = await this.client.multicall({
      contracts: tokens.flatMap((address) => [
        { address, abi: merklTokenWrapperAbi, functionName: "token" as const },
        { address, abi: merklTokenWrapperAbi, functionName: "distributor" as const },
        { address, abi: merklTokenWrapperAbi, functionName: "decimals" as const },
      ]),
      allowFailure: true,
    });

    const candidates: { wrapper: Address; underlying: Address; decimals: number }[] = [];
    tokens.forEach((wrapper, i) => {
      const token = probe[i * 3];
      const distributor = probe[i * 3 + 1];
      const decimals = probe[i * 3 + 2];
      if (token?.status !== "success" || distributor?.status !== "success") return;
      if (decimals?.status !== "success") return;
      if ((distributor.result as Address).toLowerCase() !== ADDRESSES.merklDistributor.toLowerCase()) return;
      const underlying = token.result as Address;
      if (!underlying || underlying === zeroAddress) return;
      candidates.push({ wrapper, underlying: getAddress(underlying), decimals: Number(decimals.result) });
    });
    if (candidates.length === 0) return out;

    const underlyingDecimals = await this.client.multicall({
      contracts: candidates.map((c) => ({
        address: c.underlying,
        abi: merklTokenWrapperAbi,
        functionName: "decimals" as const,
      })),
      allowFailure: true,
    });

    candidates.forEach((candidate, i) => {
      const d = underlyingDecimals[i];
      if (d?.status !== "success") return;
      if (Number(d.result) !== candidate.decimals) return; // not a 1:1 relabel
      out.set(candidate.wrapper.toLowerCase(), candidate.underlying);
    });
    return out;
  }

  private async reconcile(owner: Address, claimables: MerklClaimable[]): Promise<MerklSettled[]> {
    if (claimables.length === 0) return [];
    const tokens = claimables.map((c) => getAddress(c.token.address));

    const [claimedStates, perToken, globalRedirect, underlyings] = await Promise.all([
      this.client.multicall({
        contracts: tokens.map((token) => ({
          address: ADDRESSES.merklDistributor,
          abi: merklDistributorAbi,
          functionName: "claimed" as const,
          args: [owner, token] as const,
        })),
        allowFailure: true,
      }),
      this.client.multicall({
        contracts: tokens.map((token) => ({
          address: ADDRESSES.merklDistributor,
          abi: merklDistributorAbi,
          functionName: "claimRecipient" as const,
          args: [owner, token] as const,
        })),
        allowFailure: true,
      }),
      this.client
        .readContract({
          address: ADDRESSES.merklDistributor,
          abi: merklDistributorAbi,
          functionName: "claimRecipient",
          args: [owner, zeroAddress],
        })
        .catch(() => zeroAddress as Address),
      this.resolveUnderlying(tokens),
    ]);

    const settled: MerklSettled[] = [];
    claimables.forEach((claimable, i) => {
      const state = claimedStates[i];
      // A failed read is not permission to fall back to the API's number — that
      // is the number we do not trust. Drop the entry instead.
      if (state?.status !== "success") return;
      const onChainClaimed = (state.result as readonly [bigint, number, string])[0];
      const settledAmount = claimable.cumulativeAmount - onChainClaimed;
      if (settledAmount <= 0n) return;

      const specific = perToken[i];
      const redirect =
        specific?.status === "success" && (specific.result as Address) !== zeroAddress
          ? (specific.result as Address)
          : (globalRedirect as Address);

      settled.push({
        ...claimable,
        onChainClaimed,
        settledAmount,
        recipient: redirect !== zeroAddress ? getAddress(redirect) : owner,
        underlying: underlyings.get(tokens[i]!.toLowerCase()) ?? null,
      });
    });
    return settled;
  }

  async scan(ctx: ScanContext): Promise<{ items: UnclaimedItem[]; notes?: SourceNote[] }> {
    const { claimables, url } = await fetchMerklClaimables(ctx.owner, this.fetchImpl);
    if (claimables.length === 0) return { items: [] };

    // The API's numbers are candidates; the contract's are the report's.
    const settled = await this.reconcile(ctx.owner, claimables);
    if (settled.length === 0) return { items: [] };

    const canAutoClaim = await this.agentCanClaimFor(
      ctx.owner,
      settled.map((c) => getAddress(c.token.address)),
    );
    const claimType: ClaimType = canAutoClaim ? "permissionless" : this.claimType;

    const notes: SourceNote[] = canAutoClaim
      ? []
      : [
          {
            source: this.id,
            message:
              "Merkl needs your signature: the Distributor only lets the user (or an approved " +
              "operator) submit a claim. Approve the agent with toggleOperator to make this " +
              "one-click automatic.",
          },
        ];

    const redirected = settled.filter((c) => c.recipient.toLowerCase() !== ctx.owner.toLowerCase());
    if (redirected.length > 0) {
      notes.push({
        source: this.id,
        message:
          `${redirected.length} Merkl reward(s) are set to pay out to a different address ` +
          `(claimRecipient), not this wallet: ` +
          `${[...new Set(redirected.map((r) => r.recipient))].join(", ")}.`,
      });
    }

    // The report names what the wallet receives; the tx encodes what the merkle
    // proof commits to. For a wrapped campaign those are different addresses.
    const underlyingInfo = await loadTokenInfo(
      this.client,
      settled.flatMap((c) => (c.underlying ? [c.underlying] : [])),
    );

    const items = settled.map((c): UnclaimedItem => {
      const rewardToken = getAddress(c.token.address);
      const received = underlyingInfo.get(c.underlying?.toLowerCase() ?? "");
      const address = received?.address ?? rewardToken;
      return {
        id: `merkl:${rewardToken.toLowerCase()}`,
        source: this.id,
        owner: ctx.owner,
        token: received ?? {
          address,
          symbol: c.token.symbol ?? null,
          name: c.token.name ?? null,
          decimals: c.token.decimals ?? 18,
        },
        rawAmount: c.settledAmount,
        usdValue: null, // filled by the engine's pricing pass
        claimType,
        label:
          `Merkl incentives — ${received?.symbol ?? c.token.symbol ?? address}` +
          (c.underlying ? " (unwrapped 1:1 on claim)" : "") +
          (c.recipient.toLowerCase() === ctx.owner.toLowerCase()
            ? ""
            : ` (pays out to ${c.recipient}, not this wallet)`),
        provenance: [
          httpRead({
            url,
            call: `GET /v4/users/${ctx.owner}/rewards?chainId=${BASE_CHAIN_ID}`,
            result: {
              token: rewardToken,
              amountCumulative: c.cumulativeAmount.toString(),
              claimedPerApi: c.claimedAmount.toString(),
              root: c.root,
              proofLength: c.proofs.length,
            },
          }),
          contractRead({
            target: ADDRESSES.merklDistributor,
            call: "claimed(address user, address token) [authoritative over the API]",
            args: [ctx.owner, rewardToken],
            result: {
              claimedOnChain: c.onChainClaimed.toString(),
              claimable: c.settledAmount.toString(),
            },
          }),
          contractRead({
            target: ADDRESSES.merklDistributor,
            call: "claimRecipient(address user, address token)",
            args: [ctx.owner, rewardToken],
            result: { paysOutTo: c.recipient },
          }),
          ...(c.underlying
            ? [
                contractRead({
                  target: rewardToken,
                  call: "token() / distributor() [Merkl wrapper -> underlying, 1:1]",
                  result: { wrapper: rewardToken, receives: c.underlying },
                }),
              ]
            : []),
        ],
        meta: {
          root: c.root,
          /** The address the claim tx encodes — the wrapper, when there is one. */
          rewardToken,
          underlying: c.underlying,
          cumulativeAmount: c.cumulativeAmount.toString(),
          claimedOnChain: c.onChainClaimed.toString(),
          claimedPerApi: c.claimedAmount.toString(),
          recipient: c.recipient,
          note: "Proofs are refetched at claim time; the ones behind this read are not reused.",
        },
      };
    });

    return { items, notes };
  }

  async buildClaim(ctx: ScanContext, items: UnclaimedItem[]): Promise<ClaimTx[]> {
    const mine = items.filter((i) => i.source === this.id);
    // Match on the reward token the proof commits to. For a wrapped campaign the
    // item's display token is the underlying, which the Distributor knows nothing about.
    const wanted = new Set(
      mine.map((i) =>
        String((i.meta as { rewardToken?: string } | undefined)?.rewardToken ?? i.token.address).toLowerCase(),
      ),
    );
    if (wanted.size === 0) return [];

    // Invariant #5: proofs expire (~4h). Refetch immediately before encoding,
    // then re-check the contract's `claimed` — between scan and claim someone
    // may have claimed already, which would make this leg a no-op transfer.
    const { claimables } = await fetchMerklClaimables(ctx.owner, this.fetchImpl);
    const fresh = claimables.filter((c) => wanted.has(c.token.address.toLowerCase()));
    const legs = await this.reconcile(ctx.owner, fresh);
    if (legs.length === 0) return [];

    // The scan already established whether the agent may submit this; carry that
    // verdict through so the plan never labels a tx as auto-claimable when the
    // Distributor would revert NotWhitelisted.
    const claimType = mine.every((i) => i.claimType === "permissionless")
      ? ("permissionless" as const)
      : this.claimType;

    const users = legs.map(() => ctx.owner);
    const tokens = legs.map((l) => getAddress(l.token.address));
    const amounts = legs.map((l) => l.cumulativeAmount); // cumulative, not the delta
    const proofs = legs.map((l) => l.proofs);

    return [
      {
        to: ADDRESSES.merklDistributor,
        data: encodeFunctionData({
          abi: merklDistributorAbi,
          functionName: "claim",
          args: [users, tokens, amounts, proofs],
        }),
        value: 0n,
        chainId: ctx.chainId,
        claimType,
        description:
          `Merkl claim for ${legs.length} token(s) -> ` +
          `${[...new Set(legs.map((l) => l.recipient))].join(", ")} ` +
          `(proofs fetched ${new Date().toISOString()}, root(s): ${[...new Set(legs.map((l) => l.root))].join(", ")})`,
        itemIds: legs.map((l) => `merkl:${l.token.address.toLowerCase()}`),
      },
    ];
  }
}
