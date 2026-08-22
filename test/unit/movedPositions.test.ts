import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { findMovedPositions } from "../../src/adapters/uniswapV3Moved.js";
import { renderReport } from "../../src/format.js";
import type { ScanContext, ScanReport } from "../../src/types.js";

const OWNER = "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" as Address;
const VAULT = "0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55" as Address;
const STRANGER = "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

const ctx: ScanContext = { owner: OWNER, chainId: 8453, blockNumber: 1_000_000n };

interface Scenario {
  holder: Address;
  /** What holder.owner() returns, or null for a contract with no owner(). */
  holderOwner: Address | null;
  owed?: [bigint, bigint];
  failWindows?: boolean;
}

function client({ holder, holderOwner, owed = [5n, 0n], failWindows = false }: Scenario) {
  return {
    getLogs: async () => {
      if (failWindows) throw new Error("over rate limit");
      return [{ args: { tokenId: 42n } }];
    },
    multicall: async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => {
        if (c.functionName === "ownerOf") return { status: "success", result: holder };
        if (c.functionName === "positions") {
          return { status: "success", result: [0n, WETH, WETH, WETH, 3000, 0, 0, 0n, 0n, 0n, 0n, 0n] };
        }
        if (c.functionName === "symbol") return { status: "success", result: "WETH" };
        if (c.functionName === "name") return { status: "success", result: "Wrapped Ether" };
        if (c.functionName === "decimals") return { status: "success", result: 18 };
        return { status: "failure", error: new Error("unstubbed") };
      }),
    simulateContract: async () => ({ result: owed }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "owner" && holderOwner) return holderOwner;
      throw new Error("no owner()");
    },
  } as never;
}

describe("findMovedPositions", () => {
  it("finds fees sitting in a contract the wallet moved a position into", async () => {
    const { unreachable } = await findMovedPositions(
      client({ holder: VAULT, holderOwner: OWNER }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable).toHaveLength(1);
    expect(unreachable[0]!.holder).toBe(VAULT);
    expect(unreachable[0]!.amounts[0]!.rawAmount).toBe(5n);
  });

  it("flags a holder that names the scanned wallet as its owner", async () => {
    const { unreachable } = await findMovedPositions(
      client({ holder: VAULT, holderOwner: OWNER }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable[0]!.looksControlledByOwner).toBe(true);
    // Hint, not a promise: we still cannot build a working transaction.
    expect(unreachable[0]!.label).toMatch(/cannot build that transaction/i);
  });

  it("does not claim a position is yours when the holder says otherwise", async () => {
    const { unreachable } = await findMovedPositions(
      client({ holder: VAULT, holderOwner: STRANGER }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable[0]!.looksControlledByOwner).toBe(false);
    expect(unreachable[0]!.label).toMatch(/may not be yours/i);
  });

  it("ignores a position that came back to an address we already scanned", async () => {
    const { unreachable } = await findMovedPositions(
      client({ holder: OWNER, holderOwner: null }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable).toHaveLength(0);
  });

  it("ignores a moved position that owes nothing", async () => {
    const { unreachable } = await findMovedPositions(
      client({ holder: VAULT, holderOwner: OWNER, owed: [0n, 0n] }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable).toHaveLength(0);
  });

  it("says the search was incomplete rather than implying nothing moved", async () => {
    const { unreachable, notes } = await findMovedPositions(
      client({ holder: VAULT, holderOwner: OWNER, failWindows: true }),
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(unreachable).toHaveLength(0);
    expect(notes.some((n) => n.message.includes("INCOMPLETE"))).toBe(true);
  });

  it("states the lookback so 'none found' is not read as 'none exist'", async () => {
    const { notes } = await findMovedPositions(
      { getLogs: async () => [] } as never,
      ctx,
      [OWNER],
      { lookbackBlocks: 10_000n },
    );
    expect(notes[0]!.message).toMatch(/outside this search/i);
  });
});

describe("unreachable value in the report", () => {
  const report: ScanReport = {
    owner: OWNER,
    chainId: 8453,
    blockNumber: 1_000_000n,
    generatedAt: "2026-08-22T00:00:00.000Z",
    items: [],
    totals: { pricedUsd: 0, pricedCount: 0, unpricedCount: 0, itemCount: 0 },
    errors: [],
    notes: [],
    unreachable: [
      {
        source: "uniswap-v3",
        holder: VAULT,
        holderOwner: OWNER,
        looksControlledByOwner: true,
        label: "position #42 held by a vault",
        amounts: [
          {
            token: { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
            rawAmount: 1_000_000_000_000_000_000n,
            usdValue: 2400,
          },
        ],
        provenance: [],
      },
    ],
  };

  it("does not say 'nothing found' when unreachable value exists", () => {
    // The phantom-zero trap: zero claimable items is not zero value.
    const text = renderReport(report);
    expect(text).not.toContain("No unclaimed value found.");
    expect(text).toMatch(/nothing claimable from the address/i);
  });

  it("says 'nothing found' only when there is genuinely nothing", () => {
    const empty = renderReport({ ...report, unreachable: [] });
    expect(empty).toContain("No unclaimed value found.");
  });

  it("renders it in its own section, outside the claimable total", () => {
    const text = renderReport(report);
    expect(text).toMatch(/NOT claimable from the address/i);
    expect(text).toContain(VAULT);
    expect(text).toMatch(/excluded from the total above/i);
  });
});
