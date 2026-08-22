import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverFeeCurrencies } from "../../src/clankerCurrencies.js";
import { CLANKER_FEE_LOCKER_DEPLOY_BLOCK, LOG_WINDOW_BLOCKS } from "../../src/config.js";
import { loadCursor, saveCursor } from "../../src/cursorCache.js";

const OWNER = "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
const CLAWSTR = "0x81be0217e166182D35B21e7d65D2b2bB7ea4cB07" as const;

const START = CLANKER_FEE_LOCKER_DEPLOY_BLOCK;
const END = START + LOG_WINDOW_BLOCKS * 5n - 1n; // exactly 5 windows

/** getLogs stub: `hits` maps window index -> tokens; `failing` indexes throw. */
function stubClient(hits: Record<number, string[]>, failing: number[] = []) {
  return {
    getBlockNumber: async () => END,
    getLogs: async ({ fromBlock }: { fromBlock: bigint }) => {
      const index = Number((fromBlock - START) / LOG_WINDOW_BLOCKS);
      if (failing.includes(index)) throw new Error("over rate limit");
      return (hits[index] ?? []).map((token) => ({ args: { token } }));
    },
  } as never;
}

describe("discoverFeeCurrencies", () => {
  it("finds currencies the wallet never deployed a token for", async () => {
    const result = await discoverFeeCurrencies(stubClient({ 0: [WETH], 3: [CLAWSTR] }), OWNER, {
      fromBlock: START,
      toBlock: END,
    });
    expect(result.complete).toBe(true);
    expect(result.currencies.map((c) => c.toLowerCase()).sort()).toEqual(
      [WETH.toLowerCase(), CLAWSTR.toLowerCase()].sort(),
    );
    expect(result.watermark).toBe(END);
  });

  it("reports a partial scan as incomplete rather than as an answer", async () => {
    const result = await discoverFeeCurrencies(stubClient({ 0: [WETH] }, [2, 4]), OWNER, {
      fromBlock: START,
      toBlock: END,
      retryRounds: 0,
    });
    expect(result.complete).toBe(false);
    expect(result.failedWindows).toBe(2);
    expect(result.failureSample).toContain("rate limit");
  });

  it("stops the watermark at the first gap, not the last success", async () => {
    // Windows 0,1 succeed; 2 fails; 3,4 succeed. Caching block 4's end would
    // mean window 2 is never revisited and its currencies are lost forever.
    const result = await discoverFeeCurrencies(stubClient({}, [2]), OWNER, {
      fromBlock: START,
      toBlock: END,
      retryRounds: 0,
    });
    expect(result.watermark).toBe(START + LOG_WINDOW_BLOCKS * 2n - 1n);
    expect(result.watermark).toBeLessThan(END);
  });

  it("retries a window that fails transiently", async () => {
    let attempts = 0;
    const client = {
      getBlockNumber: async () => END,
      getLogs: async ({ fromBlock }: { fromBlock: bigint }) => {
        const index = Number((fromBlock - START) / LOG_WINDOW_BLOCKS);
        if (index === 1 && attempts++ === 0) throw new Error("over rate limit");
        return index === 1 ? [{ args: { token: CLAWSTR } }] : [];
      },
    } as never;

    const result = await discoverFeeCurrencies(client, OWNER, {
      fromBlock: START,
      toBlock: END,
      retryRounds: 1,
    });
    expect(result.complete).toBe(true);
    expect(result.currencies.map((c) => c.toLowerCase())).toContain(CLAWSTR.toLowerCase());
  });

  it("reports progress so a long scan is not a silent wait", async () => {
    const onProgress = vi.fn();
    await discoverFeeCurrencies(stubClient({}), OWNER, {
      fromBlock: START,
      toBlock: END,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledTimes(5);
    expect(onProgress).toHaveBeenLastCalledWith(5, 5, 0);
  });

  it("counts only real failures in progress, not windows still pending", async () => {
    // The bug this guards: deriving the failure count from "windows that have
    // not succeeded yet" made the first tick report every window as failed, so
    // a healthy scan opened by claiming 1,880 ranges were broken.
    const ticks: [number, number, number][] = [];
    await discoverFeeCurrencies(stubClient({}, [3]), OWNER, {
      fromBlock: START,
      toBlock: END,
      retryRounds: 0,
      concurrency: 1,
      onProgress: (done, total, failed) => ticks.push([done, total, failed]),
    });
    expect(ticks[0]![2]).toBeLessThanOrEqual(1);
    expect(ticks[ticks.length - 1]![2]).toBe(1);
    // Never more failures than windows actually attempted.
    for (const [done, , failed] of ticks) expect(failed).toBeLessThanOrEqual(done);
  });

  it("splits a range whose response is too large instead of failing it", async () => {
    // Observed live: 20 of 1828 windows returned more log data than the HTTP
    // client accepts. Retrying them unchanged fails forever — the range width
    // is the problem — so they must be halved until the pieces fit.
    const seen: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => END,
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        seen.push([fromBlock, toBlock]);
        // The first window is only readable once narrowed below half width.
        const isFirst = fromBlock < START + LOG_WINDOW_BLOCKS;
        if (isFirst && toBlock - fromBlock > LOG_WINDOW_BLOCKS / 4n) {
          throw new Error("HTTP response body exceeded the size limit.");
        }
        return isFirst ? [{ args: { token: CLAWSTR } }] : [];
      },
    } as never;

    const result = await discoverFeeCurrencies(client, OWNER, {
      fromBlock: START,
      toBlock: END,
      retryRounds: 0,
    });

    expect(result.complete).toBe(true);
    expect(result.currencies.map((c) => c.toLowerCase())).toContain(CLAWSTR.toLowerCase());
    // It actually subdivided rather than giving up.
    expect(seen.some(([f, t]) => t - f < LOG_WINDOW_BLOCKS - 1n)).toBe(true);
  });

  it("gives up on a too-large range rather than splitting forever", async () => {
    const client = {
      getBlockNumber: async () => END,
      getLogs: async () => {
        throw new Error("HTTP response body exceeded the size limit.");
      },
    } as never;
    const result = await discoverFeeCurrencies(client, OWNER, {
      fromBlock: START,
      toBlock: START + LOG_WINDOW_BLOCKS - 1n,
      retryRounds: 0,
    });
    expect(result.complete).toBe(false);
    expect(result.failedWindows).toBe(1);
  });

  it("does nothing when the cursor is already at the head", async () => {
    const result = await discoverFeeCurrencies(stubClient({}), OWNER, {
      fromBlock: END + 1n,
      toBlock: END,
    });
    expect(result.totalWindows).toBe(0);
    expect(result.complete).toBe(true);
  });
});

describe("cursorCache", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orionscope-cache-"));
    path = join(dir, "clanker-currencies.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a cursor and its currencies", () => {
    saveCursor(OWNER, { watermark: 42n, currencies: [WETH] }, path);
    const cursor = loadCursor(OWNER, path);
    expect(cursor?.cursor).toBe("42");
    expect(cursor?.currencies).toEqual([WETH.toLowerCase()]);
  });

  it("unions currencies across runs and never moves the cursor backwards", () => {
    saveCursor(OWNER, { watermark: 100n, currencies: [WETH] }, path);
    saveCursor(OWNER, { watermark: 50n, currencies: [CLAWSTR] }, path);
    const cursor = loadCursor(OWNER, path);
    expect(cursor?.cursor).toBe("100");
    expect(cursor?.currencies.sort()).toEqual([WETH.toLowerCase(), CLAWSTR.toLowerCase()].sort());
  });

  it("treats a missing or corrupt cache as no cache, not as an error", () => {
    expect(loadCursor(OWNER, join(dir, "absent.json"))).toBeNull();
  });

  it("is case-insensitive about the owner address", () => {
    saveCursor(OWNER, { watermark: 7n, currencies: [] }, path);
    expect(loadCursor(OWNER.toLowerCase() as typeof OWNER, path)?.cursor).toBe("7");
  });
});
