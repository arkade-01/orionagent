import { getAddress, type Address, type PublicClient } from "viem";
import { ClankerAdapter, type ClankerAdapterOptions } from "./adapters/clanker.js";
import { MerklAdapter } from "./adapters/merkl.js";
import { UniswapV3Adapter } from "./adapters/uniswapV3.js";
import { BASE_CHAIN_ID } from "./config.js";
import { fetchPrices, toUsdValue } from "./pricing.js";
import type {
  ClaimTx,
  ScanContext,
  ScanReport,
  SourceAdapter,
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

  const settled = await Promise.allSettled(adapters.map((a) => a.scan(ctx)));
  settled.forEach((res, i) => {
    const adapter = adapters[i]!;
    if (res.status === "fulfilled") {
      items.push(...res.value.items);
      notes.push(...(res.value.notes ?? []));
    } else {
      errors.push({
        source: adapter.id,
        stage: "scan",
        message: (res.reason as Error)?.message ?? String(res.reason),
      });
    }
  });

  const pricingFailures = await priceItems(items, options.fetchImpl);
  if (pricingFailures > 0) {
    notes.push({
      source: "clanker",
      message:
        `${pricingFailures} token(s) show as unpriced because the price API could not be ` +
        `reached, not because they have no price. The amounts themselves are unaffected.`,
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
  };
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
        message: (res.reason as Error)?.message ?? String(res.reason),
      });
  });

  txs.sort((a, b) => Number(Boolean(b.isPrerequisite)) - Number(Boolean(a.isPrerequisite)));
  return { txs, errors };
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
