import type { Address, Hex } from "viem";

export type SourceId = "clanker" | "merkl" | "uniswap-v3";

/**
 * `permissionless` — the agent may submit the claim tx itself; funds still route
 * to the owner (enforced by the contract, not by us).
 * `owner-sign` — the agent only builds the tx; the owner signs it.
 */
export type ClaimType = "permissionless" | "owner-sign";

export type ProvenanceKind =
  | "contract-read"
  | "contract-static-call"
  | "http-api"
  | "sdk-read";

/**
 * The receipt for a number. Invariant #1: every `rawAmount` in a report traces
 * back to one of these, and every figure the brief narrates traces back to a
 * `rawAmount`. Nothing is estimated, interpolated, or rounded into existence.
 */
export interface Provenance {
  kind: ProvenanceKind;
  /** Contract address or API origin the value came from. */
  target: string;
  /** Function name or endpoint path. */
  call: string;
  /** Arguments, stringified (bigints included). */
  args?: string[];
  /** The value exactly as returned, stringified. */
  result: string;
  /** Block the read was pinned to, when it was an on-chain read. */
  blockNumber?: bigint;
  fetchedAt: string;
}

export interface TokenInfo {
  address: Address;
  symbol: string | null;
  name: string | null;
  decimals: number;
}

/**
 * Why a token has no USD value. "The price source said nothing about this thin
 * token" and "we could not reach the price source" both yield `usdValue: null`,
 * but they mean very different things to a reader, so they are kept apart.
 */
export type PriceStatus = "priced" | "no-reliable-price" | "lookup-failed";

export interface PriceInfo {
  /** USD per whole token. `null` means "no reliable price" — never a guess. */
  usdPerToken: number | null;
  status: PriceStatus;
  confidence: number | null;
  source: string;
  fetchedAt: string;
}

/** One claimable position, from one source, in one token. */
export interface UnclaimedItem {
  /** Stable within a report: `${source}:${...discriminators}`. */
  id: string;
  source: SourceId;
  owner: Address;
  token: TokenInfo;
  /** Base units. THE claim number — all claim logic uses this, never usdValue. */
  rawAmount: bigint;
  /** Display/ranking only. `null` when unpriced. */
  usdValue: number | null;
  claimType: ClaimType;
  /** Short human label, e.g. "Uniswap v3 LP fees — position #12345". */
  label: string;
  provenance: Provenance[];
  price?: PriceInfo;
  /** Adapter-specific payload needed to build the claim (proofs, tokenId, ...). */
  meta?: Record<string, unknown>;
}

export interface ClaimTx {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  claimType: ClaimType;
  /** Human description of exactly what this tx does. */
  description: string;
  /** Ids of the `UnclaimedItem`s this tx settles. */
  itemIds: string[];
  /**
   * A harvest/sweep that must land before the claim in the same batch.
   * Present only when the adapter needs a pool -> locker sweep first.
   */
  isPrerequisite?: boolean;
}

/** A source that could not be read. We report the gap; we never fill it in. */
export interface SourceError {
  source: SourceId;
  stage: "scan" | "claim";
  message: string;
}

/**
 * A stable identifier for notes whose wording is surface-specific.
 *
 * The default `message` is written for the CLI and names CLI flags. A web UI has
 * no `--also` flag, so telling a visitor to pass one is noise at best and
 * confusing at worst. Surfaces key off `code` to substitute their own copy, and
 * fall back to `message` for anything they do not recognise.
 */
export type NoteCode =
  | "uniswap-scope"
  | "clanker-fast-scan"
  | "clanker-untraced"
  | "clanker-harvested-only"
  | "pricing-unavailable";

/** Something found but deliberately not listed as claimable (e.g. legacy Clanker). */
export interface SourceNote {
  source: SourceId;
  message: string;
  code?: NoteCode;
}

/**
 * Value that demonstrably exists but cannot be claimed from any address we were
 * asked about — a Uniswap position sitting in a Safe or an automation contract,
 * for instance.
 *
 * These are deliberately NOT `UnclaimedItem`s. `collect` has to be called by the
 * NFT's holder, so we cannot build a transaction that works, and listing them
 * as claimable would promise money the tool cannot deliver. They are reported
 * so the owner knows where to look, and excluded from every total.
 */
export interface UnreachableValue {
  source: SourceId;
  /** The contract that actually holds the position. */
  holder: Address;
  /** What the holder reports via `owner()` / `getOwners()`, when it exposes one. */
  holderOwner: Address | null;
  /** True when `holderOwner` is one of the addresses we were asked to scan. */
  looksControlledByOwner: boolean;
  label: string;
  /** Real amounts, read the same way a claimable item's would be. */
  amounts: { token: TokenInfo; rawAmount: bigint; usdValue: number | null }[];
  provenance: Provenance[];
}

export interface ScanReport {
  owner: Address;
  chainId: number;
  /** Block every on-chain read in this report was pinned to. */
  blockNumber: bigint;
  generatedAt: string;
  items: UnclaimedItem[];
  totals: {
    /** Sum of `usdValue` over priced items only. */
    pricedUsd: number;
    pricedCount: number;
    /** Items with a real amount but no reliable price. Surfaced as "unpriced". */
    unpricedCount: number;
    itemCount: number;
  };
  errors: SourceError[];
  notes: SourceNote[];
  /** Found, real, but not claimable from the scanned addresses. Never in totals. */
  unreachable: UnreachableValue[];
}

export interface ScanContext {
  owner: Address;
  chainId: number;
  /** All on-chain reads in a scan pin to this block for a consistent snapshot. */
  blockNumber: bigint;
}

export interface SourceAdapter {
  readonly id: SourceId;
  readonly claimType: ClaimType;
  /** Read-only. Must never return an item it could not read a real amount for. */
  scan(ctx: ScanContext): Promise<{ items: UnclaimedItem[]; notes?: SourceNote[] }>;
  /**
   * Build the txs that settle `items`. Adapters with expiring inputs (Merkl
   * proofs) MUST refetch here rather than reuse anything from `scan`.
   */
  buildClaim(ctx: ScanContext, items: UnclaimedItem[]): Promise<ClaimTx[]>;
}
