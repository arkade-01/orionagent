import { getAddress, parseAbiItem, type Address, type PublicClient } from "viem";
import {
  ADDRESSES,
  CLANKER_FEE_LOCKER_DEPLOY_BLOCK,
  LOG_WINDOW_BLOCKS,
} from "./config.js";
import { summarizeError } from "./errors.js";

/**
 * `feeOwner` is an indexed topic, so the chain can answer "which currencies has
 * this owner ever been paid in?" exactly — no index, no guessing at pairings.
 */
const STORE_TOKENS = parseAbiItem(
  "event StoreTokens(address indexed sender, address indexed feeOwner, address indexed token, uint256 balance, uint256 amount)",
);

export interface DiscoveryOptions {
  /** Resume point. Defaults to the FeeLocker's deploy block. */
  fromBlock?: bigint;
  toBlock?: bigint;
  /** Parallel `eth_getLogs` requests. Paid RPCs handle 10-20 comfortably. */
  concurrency?: number;
  /** Extra passes over windows that failed, before giving up on them. */
  retryRounds?: number;
  onProgress?: (done: number, total: number, failed: number) => void;
}

export interface CurrencyDiscovery {
  currencies: Address[];
  /**
   * Highest block with an unbroken run of successful windows behind it. Only
   * this is safe to cache: caching past a gap would bake the gap in permanently,
   * since a resumed scan never looks below its cursor again.
   */
  watermark: bigint;
  scannedFrom: bigint;
  scannedTo: bigint;
  totalWindows: number;
  /** Windows still failing after every retry round. */
  failedWindows: number;
  /**
   * False when any window failed. A partial discovery must never be presented
   * as "these are your currencies" — it is "these are some of your currencies".
   */
  complete: boolean;
  /** One-line reason for the first failure, for the report.  */
  failureSample?: string;
}

/**
 * Walk `StoreTokens` for one owner and return every currency they have ever
 * accrued fees in.
 *
 * The FeeLocker is keyed on `(feeOwner, currency)` and fees accrue in BOTH sides
 * of a pool, so an owner's currency set is not derivable from the tokens they
 * deployed, nor from the handful of currencies Clanker commonly pairs against.
 * This is the only way to get it right.
 *
 * Partial results are reported, never hidden. On a rate-limited public RPC over
 * 90% of windows fail, and a version of this that swallowed those failures would
 * return a confident, badly incomplete answer — the exact failure this whole
 * adapter exists to avoid.
 */
export async function discoverFeeCurrencies(
  client: PublicClient,
  owner: Address,
  options: DiscoveryOptions = {},
): Promise<CurrencyDiscovery> {
  const scannedFrom = options.fromBlock ?? CLANKER_FEE_LOCKER_DEPLOY_BLOCK;
  const scannedTo = options.toBlock ?? (await client.getBlockNumber());
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const retryRounds = Math.max(0, options.retryRounds ?? 2);

  if (scannedTo < scannedFrom) {
    return {
      currencies: [],
      watermark: scannedTo,
      scannedFrom,
      scannedTo,
      totalWindows: 0,
      failedWindows: 0,
      complete: true,
    };
  }

  const windows: { from: bigint; to: bigint }[] = [];
  for (let f = scannedFrom; f <= scannedTo; f += LOG_WINDOW_BLOCKS) {
    const to = f + LOG_WINDOW_BLOCKS - 1n;
    windows.push({ from: f, to: to > scannedTo ? scannedTo : to });
  }

  const ok = new Array<boolean>(windows.length).fill(false);
  const currencies = new Set<string>();
  let failureSample: string | undefined;

  /**
   * Progress is derived from these two arrays rather than counted, which three
   * separate bugs argued for:
   *  - counting "windows not yet succeeded" as failures made the first tick
   *    report all 1880 as failed before any had run;
   *  - counting raw attempts let retry rounds run the bar past 100% (2273/1880);
   *  - incrementing a failure tally double-counted windows that failed twice.
   * Attempted-and-not-yet-succeeded is true by construction at every instant,
   * and falls as retries land.
   */
  const attempted = new Array<boolean>(windows.length).fill(false);
  const report = () => {
    if (!options.onProgress) return;
    let done = 0;
    let failing = 0;
    for (const [i, seen] of attempted.entries()) {
      if (!seen) continue;
      done++;
      if (!ok[i]) failing++;
    }
    options.onProgress(done, windows.length, failing);
  };

  /**
   * A busy 10k-block range can return more log data than the HTTP client will
   * accept ("response body exceeded the size limit"). Retrying it unchanged
   * fails forever — the range itself is the problem — so it is halved until the
   * pieces fit. Measured on Base: 20 of 1828 windows needed this.
   */
  const isTooLarge = (err: unknown): boolean => {
    const text = String((err as Error)?.message ?? err).toLowerCase();
    return (
      text.includes("exceeded the size limit") ||
      text.includes("response size") ||
      text.includes("too many results") ||
      text.includes("query returned more than")
    );
  };

  /**
   * 5 takes a 10k window down to ~312 blocks, which has been enough. Deeper
   * mostly buys a long silent tail: each level doubles the request count, and a
   * window is only reported once every piece of it is done.
   */
  const MAX_SPLIT_DEPTH = 5;

  const readRange = async (from: bigint, to: bigint, depth = 0): Promise<void> => {
    try {
      const logs = await client.getLogs({
        address: ADDRESSES.clankerFeeLocker,
        event: STORE_TOKENS,
        args: { feeOwner: owner },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const token = (log.args as { token?: Address }).token;
        if (token) currencies.add(token.toLowerCase());
      }
    } catch (err) {
      if (isTooLarge(err) && to > from && depth < MAX_SPLIT_DEPTH) {
        // In parallel, not one after the other. Sequential halves made a single
        // oversized window take hundreds of round trips, and since a window
        // reports progress only when it finishes, the whole scan appeared to
        // freeze at 98% while it ground through them.
        const mid = from + (to - from) / 2n;
        await Promise.all([readRange(from, mid, depth + 1), readRange(mid + 1n, to, depth + 1)]);
        return;
      }
      throw err;
    }
  };

  const runWindow = async (index: number): Promise<void> => {
    const w = windows[index]!;
    try {
      await readRange(w.from, w.to);
      ok[index] = true;
    } catch (err) {
      failureSample ??= summarizeError(err);
    } finally {
      // Reported from here, not from the worker loop: reporting after
      // `await runWindow(...)` let a dozen concurrent failures land before the
      // first tick, and the UI showed "12 failed of 1 checked".
      attempted[index] = true;
      report();
    }
  };

  const drain = async (indices: number[]): Promise<void> => {
    const queue = [...indices];
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (;;) {
          const index = queue.pop();
          if (index === undefined) return;
          await runWindow(index);
        }
      }),
    );
  };

  await drain(windows.map((_, i) => i));

  // Retries get progressively more patient; rate limits are the usual cause and
  // they clear with time rather than with immediate repetition.
  for (let round = 0; round < retryRounds; round++) {
    const pending = ok.flatMap((success, i) => (success ? [] : [i]));
    if (pending.length === 0) break;
    await new Promise((r) => setTimeout(r, 1000 * (round + 1)));
    await drain(pending);
  }

  // Watermark stops at the first gap, not at the last success.
  let watermark = scannedFrom > 0n ? scannedFrom - 1n : 0n;
  for (const [i, success] of ok.entries()) {
    if (!success) break;
    watermark = windows[i]!.to;
  }

  const failedWindows = ok.filter((v) => !v).length;
  return {
    currencies: [...currencies].map((c) => getAddress(c)),
    watermark,
    scannedFrom,
    scannedTo,
    totalWindows: windows.length,
    failedWindows,
    complete: failedWindows === 0,
    ...(failureSample ? { failureSample } : {}),
  };
}
