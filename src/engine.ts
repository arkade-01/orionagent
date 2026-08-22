import { getAddress, type Address, type PublicClient } from "viem";
import { ClankerAdapter, type ClankerAdapterOptions } from "./adapters/clanker.js";
import { MerklAdapter } from "./adapters/merkl.js";
import { UniswapV3Adapter } from "./adapters/uniswapV3.js";
import { findMovedPositions } from "./adapters/uniswapV3Moved.js";
import { BASE_CHAIN_ID } from "./config.js";
import { summarizeError } from "./errors.js";
import { fetchPrices, toUsdValue } from "./pricing.js";
import type {
  ClaimTx,
  ScanContext,
  ScanReport,
  SourceAdapter,
  UnreachableValue,
  SourceError,
  SourceId,
  SourceNote,
  UnclaimedItem,
} from "./types.js";

export interface EngineOptions {
  sources?: SourceId[];
  clanker?: ClankerAdapterOptions;
  fetchImpl?: typeof fetch;
  /** Pin the scan to a specific block. Defaults to latest at scan time. */
  blockNumber?: bigint;
  /**
   * The agent signer, when configured. Only used to check whether a source will
   * actually accept a tx from it — Merkl's Distributor rejects unapproved
   * callers, so without this every Merkl item is correctly reported owner-sign.
   */
  agentAddress?: Address;
  /**
   * Search for Uniswap positions this wallet transferred away that still owe
   * fees. Reported as `unreachable`: real amounts, but `collect` must come from
   * the holder, so they are never presented as claimable or counted in totals.
   */
  findMoved?: boolean;
  /** Lookback for the moved-position search. Default ~11 days. */
  findMovedLookback?: bigint;
  /**
   * Fired as each source finishes, so a caller can show work in progress
   * instead of a spinner. Sources run concurrently and report out of order.
   */
  onSourceDone?: (event: {
    source: SourceId;
    status: "ok" | "failed";
    itemCount?: number;
    message?: string;
  }) => void;
}

export function buildAdapters(client: PublicClient, options: EngineOptions = {}): SourceAdapter[] {
  const all: SourceAdapter[] = [
    new MerklAdapter(client, options.fetchImpl, options.agentAddress),
    new UniswapV3Adapter(client),
    new ClankerAdapter(client, { fetchImpl: options.fetchImpl, ...options.clanker }),
  ];
  if (!options.sources) return all;
  const wanted = new Set(options.sources);
  return all.filter((a) => wanted.has(a.id));
}

/**
 * Deterministic wallet scan.
 *
 * Every adapter runs against the same pinned block so the report is one coherent
 * snapshot. A source that fails is recorded in `errors` and contributes nothing —
 * a partial report is correct, a padded one is not.
 */
export async function scanWallet(
  client: PublicClient,
  ownerInput: Address,
  options: EngineOptions = {},
): Promise<ScanReport> {
  const owner = getAddress(ownerInput);
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const ctx: ScanContext = { owner, chainId: BASE_CHAIN_ID, blockNumber };

  const adapters = buildAdapters(client, options);
  const errors: SourceError[] = [];
  const notes: SourceNote[] = [];
  const items: UnclaimedItem[] = [];

  const settled = await Promise.allSettled(
    adapters.map(async (a) => {
      try {
        const result = await a.scan(ctx);
        options.onSourceDone?.({ source: a.id, status: "ok", itemCount: result.items.length });
        return result;
      } catch (err) {
        options.onSourceDone?.({ source: a.id, status: "failed", message: summarizeError(err) });
        throw err;
      }
    }),
  );
  settled.forEach((res, i) => {
    const adapter = adapters[i]!;
    if (res.status === "fulfilled") {
      items.push(...res.value.items);
      notes.push(...(res.value.notes ?? []));
    } else {
      errors.push({
        source: adapter.id,
        stage: "scan",
        message: summarizeError(res.reason),
      });
    }
  });

  // Positions this wallet moved into a contract. Real fees, but `collect` has to
  // come from the holder, so they are reported separately and never totalled.
  const unreachable: UnreachableValue[] = [];
  if (options.findMoved) {
    try {
      const moved = await findMovedPositions(client, ctx, [owner], {
        ...(options.findMovedLookback ? { lookbackBlocks: options.findMovedLookback } : {}),
      });
      unreachable.push(...moved.unreachable);
      notes.push(...moved.notes);
    } catch (err) {
      errors.push({ source: "uniswap-v3", stage: "scan", message: summarizeError(err) });
    }
  }

  const pricingFailures = await priceItems(items, options.fetchImpl);
  await priceUnreachable(unreachable, options.fetchImpl);
  if (pricingFailures > 0) {
    notes.push({
      source: "clanker",
      message:
        `${pricingFailures} token(s) show as unpriced because the price API could not be ` +
        `reached, not because they have no price. The amounts themselves are unaffected.`,
      code: "pricing-unavailable",
    });
  }

  // Priced first (descending), then unpriced by source/label so ordering is stable.
  items.sort((a, b) => {
    if (a.usdValue !== null && b.usdValue !== null) return b.usdValue - a.usdValue;
    if (a.usdValue !== null) return -1;
    if (b.usdValue !== null) return 1;
    return a.id.localeCompare(b.id);
  });

  const priced = items.filter((i) => i.usdValue !== null);
  return {
    owner,
    chainId: BASE_CHAIN_ID,
    blockNumber,
    generatedAt: new Date().toISOString(),
    items,
    totals: {
      pricedUsd: priced.reduce((sum, i) => sum + (i.usdValue ?? 0), 0),
      pricedCount: priced.length,
      unpricedCount: items.length - priced.length,
      itemCount: items.length,
    },
    errors,
    notes,
    unreachable,
  };
}

/**
 * Unreachable amounts get priced like any other real read — the owner deserves
 * to know the scale of what is sitting out of reach — but they never enter
 * `totals`, which describes only what can actually be claimed.
 */
async function priceUnreachable(
  unreachable: UnreachableValue[],
  fetchImpl?: typeof fetch,
): Promise<void> {
  const amounts = unreachable.flatMap((u) => u.amounts);
  if (amounts.length === 0) return;
  const prices = await fetchPrices(
    amounts.map((a) => a.token.address),
    fetchImpl ?? fetch,
  );
  for (const a of amounts) {
    a.usdValue = toUsdValue(a.rawAmount, a.token, prices.get(a.token.address.toLowerCase()));
  }
}

/**
 * Attaches USD values in place. Display/ranking only — rawAmount is untouched.
 * Returns how many items went unpriced because the lookup failed rather than
 * because no trustworthy price exists.
 */
export async function priceItems(items: UnclaimedItem[], fetchImpl?: typeof fetch): Promise<number> {
  if (items.length === 0) return 0;
  const prices = await fetchPrices(
    items.map((i) => i.token.address),
    fetchImpl ?? fetch,
  );
  let failures = 0;
  for (const item of items) {
    const price = prices.get(item.token.address.toLowerCase());
    item.price = price;
    item.usdValue = toUsdValue(item.rawAmount, item.token, price);
    if (price?.status === "lookup-failed") failures++;
  }
  return failures;
}

/**
 * Build the txs that settle a report.
 *
 * Adapters are re-invoked here, not replayed from the scan, so anything with a
 * short shelf life (Merkl proofs) is fetched fresh. Prerequisite txs (e.g. a
 * Clanker pool sweep) are ordered before the claims that depend on them.
 */
export async function buildClaimPlan(
  client: PublicClient,
  report: ScanReport,
  options: EngineOptions = {},
): Promise<{ txs: ClaimTx[]; errors: SourceError[] }> {
  const ctx: ScanContext = {
    owner: report.owner,
    chainId: report.chainId,
    blockNumber: report.blockNumber,
  };
  const adapters = buildAdapters(client, options);
  const errors: SourceError[] = [];
  const txs: ClaimTx[] = [];

  const settled = await Promise.allSettled(
    adapters.map((a) => a.buildClaim(ctx, report.items.filter((i) => i.source === a.id))),
  );
  settled.forEach((res, i) => {
    const adapter = adapters[i]!;
    if (res.status === "fulfilled") txs.push(...res.value);
    else
      errors.push({
        source: adapter.id,
        stage: "claim",
        message: summarizeError(res.reason),
      });
  });

  txs.sort((a, b) => Number(Boolean(b.isPrerequisite)) - Number(Boolean(a.isPrerequisite)));
  return { txs, errors };
}

/**
 * Scan several addresses the same person controls and merge the results.
 *
 * A Uniswap position moved into a Safe or a personal vault is owned by that
 * contract: `collect` must be called by it, so those fees are invisible to a
 * scan of the human's EOA and cannot be claimed from it either. The same is true
 * of a Clanker fee recipient that is a Safe. Rather than guess at which
 * contracts a wallet controls — which is not decidable from chain data — the
 * caller names them.
 *
 * Each item keeps its own `owner`, so a claim plan built from this report still
 * targets the address that actually has to sign.
 */
export async function scanWallets(
  client: PublicClient,
  owners: Address[],
  options: EngineOptions = {},
): Promise<ScanReport> {
  const unique = [...new Set(owners.map((o) => getAddress(o)))];
  const primary = unique[0];
  if (!primary) throw new Error("scanWallets needs at least one address.");
  if (unique.length === 1) return scanWallet(client, primary, options);

  // One block for every address, so the merged report is a single snapshot.
  const blockNumber = options.blockNumber ?? (await client.getBlockNumber());
  const reports = await Promise.all(
    unique.map((owner) => scanWallet(client, owner, { ...options, blockNumber })),
  );

  const merged: ScanReport = {
    owner: primary,
    chainId: BASE_CHAIN_ID,
    blockNumber,
    generatedAt: new Date().toISOString(),
    items: reports.flatMap((r) => r.items),
    totals: { pricedUsd: 0, pricedCount: 0, unpricedCount: 0, itemCount: 0 },
    errors: reports.flatMap((r) => r.errors),
    unreachable: reports.flatMap((r) => r.unreachable),
    // Notes repeat per address; keep one of each so the report stays readable.
    notes: dedupeNotes(reports.flatMap((r) => r.notes)),
  };

  merged.notes.unshift({
    source: "uniswap-v3",
    message:
      `Merged scan across ${unique.length} addresses: ${unique.join(", ")}. Each item records the ` +
      `address that holds it, which is the one that must sign to claim it.`,
  });

  merged.items.sort((a, b) => {
    if (a.usdValue !== null && b.usdValue !== null) return b.usdValue - a.usdValue;
    if (a.usdValue !== null) return -1;
    if (b.usdValue !== null) return 1;
    return a.id.localeCompare(b.id);
  });

  const priced = merged.items.filter((i) => i.usdValue !== null);
  merged.totals = {
    pricedUsd: priced.reduce((sum, i) => sum + (i.usdValue ?? 0), 0),
    pricedCount: priced.length,
    unpricedCount: merged.items.length - priced.length,
    itemCount: merged.items.length,
  };
  return merged;
}

function dedupeNotes(notes: SourceNote[]): SourceNote[] {
  const seen = new Set<string>();
  return notes.filter((n) => {
    const key = `${n.source}:${n.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "Auto-claimable now" vs "One-click, needs your signature". */
export function groupByClaimType(items: UnclaimedItem[]): {
  permissionless: UnclaimedItem[];
  ownerSign: UnclaimedItem[];
} {
  return {
    permissionless: items.filter((i) => i.claimType === "permissionless"),
    ownerSign: items.filter((i) => i.claimType === "owner-sign"),
  };
}
