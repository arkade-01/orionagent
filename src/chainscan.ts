import { getAddress, type Address, type PublicClient } from "viem";
import { clankerFeeLockerAbi } from "./abis/clankerFeeLocker.js";
import { ADDRESSES } from "./config.js";
import { fetchPrices, toUsdValue } from "./pricing.js";
import { contractRead } from "./provenance.js";
import { loadTokenInfo } from "./tokens.js";
import type { Provenance, TokenInfo } from "./types.js";

/** Public Base RPCs reject wider eth_getLogs windows; 10k blocks is ~5.5h. */
const LOG_CHUNK = 10_000n;

export interface Lead {
  token: TokenInfo;
  recipient: Address;
  /** Harvested FeeLocker balance, base units. A real read, never modelled. */
  rawAmount: bigint;
  usdValue: number | null;
  /** No `ClaimTokens` for this (recipient, token) in the lookback window. */
  looksInactive: boolean;
  lastClaimBlock: bigint | null;
  /** Block of the most recent harvest into the locker, if seen in the window. */
  lastAccrualBlock: bigint | null;
  provenance: Provenance[];
}

export interface ChainScanResult {
  blockNumber: bigint;
  fromBlock: bigint;
  /** Distinct (recipient, token) pairs that accrued fees in the window. */
  scannedPairs: number;
  leads: Lead[];
  notes: string[];
}

interface LogWindow {
  fromBlock: bigint;
  toBlock: bigint;
}

async function* chunks(from: bigint, to: bigint, size: bigint): AsyncGenerator<LogWindow> {
  for (let start = from; start <= to; start += size) {
    const end = start + size - 1n > to ? to : start + size - 1n;
    yield { fromBlock: start, toBlock: end };
  }
}

/**
 * Clanker lead ranking.
 *
 * The token universe comes from the FeeLocker's own `StoreTokens` events rather
 * than a REST listing: every harvest into the locker emits one, so the events
 * are exactly the set of (recipient, token) pairs that have earned something.
 * The REST "recent tokens" feed is the wrong universe here — it is ordered by
 * deploy time, and a token deployed an hour ago has no fees to be sitting on.
 *
 * Every reported amount is a live `availableFees` read at the pinned block. A
 * recipient with accrual in the window but no `ClaimTokens` is the lead.
 */
export async function chainScanClanker(
  client: PublicClient,
  opts: {
    /** How far back to look for accrual and claim activity. Base is ~2s/block. */
    lookbackBlocks?: bigint;
    minUsd?: number;
    /** Cap on pairs read, highest-accrual first. Keeps a scan bounded. */
    maxPairs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ChainScanResult> {
  const blockNumber = await client.getBlockNumber();
  const lookback = opts.lookbackBlocks ?? 20_000n;
  const fromBlock = blockNumber > lookback ? blockNumber - lookback : 0n;
  const notes: string[] = [];

  // (recipient, token) -> most recent block we saw fees stored for them.
  const accrual = new Map<string, { recipient: Address; token: Address; block: bigint }>();
  const lastClaim = new Map<string, bigint>();

  for await (const window of chunks(fromBlock, blockNumber, LOG_CHUNK)) {
    try {
      const [stores, claims] = await Promise.all([
        client.getContractEvents({
          address: ADDRESSES.clankerFeeLocker,
          abi: clankerFeeLockerAbi,
          eventName: "StoreTokens",
          ...window,
        }),
        client.getContractEvents({
          address: ADDRESSES.clankerFeeLocker,
          abi: clankerFeeLockerAbi,
          eventName: "ClaimTokens",
          ...window,
        }),
      ]);

      for (const log of stores) {
        const args = log.args as { feeOwner?: Address; token?: Address };
        if (!args.feeOwner || !args.token) continue;
        const recipient = getAddress(args.feeOwner);
        const token = getAddress(args.token);
        const key = `${recipient.toLowerCase()}:${token.toLowerCase()}`;
        const at = log.blockNumber ?? 0n;
        const prev = accrual.get(key);
        if (!prev || prev.block < at) accrual.set(key, { recipient, token, block: at });
      }

      for (const log of claims) {
        const args = log.args as { feeOwner?: Address; token?: Address };
        if (!args.feeOwner || !args.token) continue;
        const key = `${args.feeOwner.toLowerCase()}:${args.token.toLowerCase()}`;
        const at = log.blockNumber ?? 0n;
        if ((lastClaim.get(key) ?? 0n) < at) lastClaim.set(key, at);
      }
    } catch (err) {
      notes.push(
        `Log window ${window.fromBlock}-${window.toBlock} failed (${(err as Error).message.split("\n")[0]}); ` +
          `pairs in that range are missing from this scan.`,
      );
    }
  }

  if (accrual.size === 0) {
    return { blockNumber, fromBlock, scannedPairs: 0, leads: [], notes };
  }

  // Most recently active pairs first, so a capped scan keeps the freshest ones.
  const pairs = [...accrual.values()].sort((a, b) => Number(b.block - a.block));
  const capped = pairs.slice(0, opts.maxPairs ?? 500);
  if (capped.length < pairs.length) {
    notes.push(`${pairs.length} pairs found; read the ${capped.length} most recent (raise --max-pairs for more).`);
  }

  const balances = await client.multicall({
    contracts: capped.map((p) => ({
      address: ADDRESSES.clankerFeeLocker,
      abi: clankerFeeLockerAbi,
      functionName: "availableFees" as const,
      args: [p.recipient, p.token] as const,
    })),
    allowFailure: true,
    blockNumber,
  });

  const hits = capped.flatMap((pair, i) => {
    const r = balances[i];
    if (r?.status !== "success") return [];
    const rawAmount = r.result as bigint;
    return rawAmount > 0n ? [{ ...pair, rawAmount }] : [];
  });
  if (hits.length === 0) {
    return { blockNumber, fromBlock, scannedPairs: capped.length, leads: [], notes };
  }

  const [tokenInfo, prices] = await Promise.all([
    loadTokenInfo(client, hits.map((h) => h.token), blockNumber),
    fetchPrices(hits.map((h) => h.token), opts.fetchImpl ?? fetch),
  ]);

  const leads = hits.map((hit): Lead => {
    const info = tokenInfo.get(hit.token.toLowerCase()) ?? {
      address: hit.token,
      symbol: null,
      name: null,
      decimals: 18,
    };
    const key = `${hit.recipient.toLowerCase()}:${hit.token.toLowerCase()}`;
    const lastClaimBlock = lastClaim.get(key) ?? null;
    return {
      token: info,
      recipient: hit.recipient,
      rawAmount: hit.rawAmount,
      usdValue: toUsdValue(hit.rawAmount, info, prices.get(hit.token.toLowerCase())),
      looksInactive: lastClaimBlock === null,
      lastClaimBlock,
      lastAccrualBlock: hit.block,
      provenance: [
        contractRead({
          target: ADDRESSES.clankerFeeLocker,
          call: "availableFees(address feeOwner, address token)",
          args: [hit.recipient, hit.token],
          result: hit.rawAmount,
          blockNumber,
        }),
        contractRead({
          target: ADDRESSES.clankerFeeLocker,
          call: `StoreTokens(feeOwner, token) logs [${fromBlock}, ${blockNumber}]`,
          args: [hit.recipient, hit.token],
          result: { lastAccrualBlock: hit.block, lastClaimBlock },
          blockNumber,
        }),
      ],
    };
  });

  const minUsd = opts.minUsd ?? 0;
  const filtered = leads.filter((l) => (l.usdValue === null ? minUsd === 0 : l.usdValue >= minUsd));
  filtered.sort((a, b) => (b.usdValue ?? -1) - (a.usdValue ?? -1));

  return { blockNumber, fromBlock, scannedPairs: capped.length, leads: filtered, notes };
}
