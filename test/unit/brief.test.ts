import { describe, expect, it } from "vitest";
import { buildFacts, deterministicBrief, verifyBrief, writeBrief } from "../../src/agent/brief.js";
import type { ScanReport } from "../../src/types.js";

const report: ScanReport = {
  owner: "0xc26e7631Cf710CF39f8fe50456eb9FE502180087",
  chainId: 8453,
  blockNumber: 50172962n,
  generatedAt: "2026-08-19T10:27:55.490Z",
  items: [
    {
      id: "clanker:0x4200000000000000000000000000000000000006",
      source: "clanker",
      owner: "0xc26e7631Cf710CF39f8fe50456eb9FE502180087",
      token: {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        name: "Wrapped Ether",
        decimals: 18,
      },
      rawAmount: 5_260_525_213_286_241_524n,
      usdValue: 10083.61,
      claimType: "permissionless",
      label: "Clanker creator fees in WETH",
      provenance: [
        {
          kind: "contract-read",
          target: "0xF3622742b1E446D92e45E22923Ef11C2fcD55D68",
          call: "availableFees(address,address)",
          result: "5260525213286241524",
          fetchedAt: "2026-08-19T10:27:55.490Z",
        },
      ],
    },
    {
      id: "uniswap-v3:1:0",
      source: "uniswap-v3",
      owner: "0xc26e7631Cf710CF39f8fe50456eb9FE502180087",
      token: { address: "0x00000000000000000000000000000000000000ff", symbol: "THIN", name: null, decimals: 18 },
      rawAmount: 2_908_713_708_723_224_815_444n,
      usdValue: null,
      claimType: "owner-sign",
      label: "Uniswap v3 LP fees — position #1",
      provenance: [
        {
          kind: "contract-static-call",
          target: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
          call: "collect(...)",
          result: "2908713708723224815444",
          fetchedAt: "2026-08-19T10:27:55.490Z",
        },
      ],
    },
  ],
  totals: { pricedUsd: 10083.61, pricedCount: 1, unpricedCount: 1, itemCount: 2 },
  errors: [],
  notes: [],
};

describe("brief facts", () => {
  it("allows every figure it hands the model, in both raw and decimal form", () => {
    const { allowedNumbers } = buildFacts(report);
    expect(allowedNumbers.has("5260525213286241524")).toBe(true);
    expect(allowedNumbers.has("5.260525213286241524")).toBe(true);
    expect(allowedNumbers.has("10083.61")).toBe(true);
    expect(allowedNumbers.has("50172962")).toBe(true);
  });

  it("never allows a figure for an unpriced item's USD value", () => {
    const { allowedNumbers, lines } = buildFacts(report);
    expect(lines.join("\n")).toContain("usd: unpriced");
    // Nothing in the allow-set could be read as a dollar value for the thin token.
    expect(allowedNumbers.has("0.00")).toBe(false);
  });
});

describe("verifyBrief", () => {
  const allowed = buildFacts(report).allowedNumbers;

  it("accepts a brief that only copies supplied figures", () => {
    const text =
      "This wallet holds 5.260525213286241524 WETH in Clanker creator fees, worth $10083.61, " +
      "claimable automatically. A Uniswap v3 position also owes 2908.713708723224815444 tokens, " +
      "which are unpriced and need your signature. Read at block 50172962.";
    expect(verifyBrief(text, allowed)).toEqual([]);
  });

  it("rejects an invented total", () => {
    const text = "Across both positions the wallet is owed roughly $12500.00.";
    expect(verifyBrief(text, allowed)).toContain("12500.00");
  });

  it("rejects a rounded restatement of a real figure", () => {
    expect(verifyBrief("You have about 5.26 WETH waiting.", allowed)).toContain("5.26");
  });

  it("rejects a fabricated price for an unpriced item", () => {
    expect(verifyBrief("The unpriced token is worth around $250.", allowed)).toContain("250");
  });

  it("tolerates thousands separators and trailing zeros", () => {
    expect(verifyBrief("Worth $10,083.61 today.", allowed)).toEqual([]);
    expect(verifyBrief("Worth $10083.610 today.", allowed)).toEqual([]);
  });
});

describe("writeBrief", () => {
  it("falls back to the deterministic brief with no API key", async () => {
    const result = await writeBrief(report, { apiKey: "" });
    expect(result.origin).toBe("deterministic");
    expect(result.text).toContain("5.260525213286241524 WETH");
  });

  it("discards an LLM brief containing a figure we never supplied", async () => {
    const client = {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "You are owed a grand total of $99999.99." }],
        }),
      },
    };
    const result = await writeBrief(report, { client: client as never });
    expect(result.origin).toBe("deterministic");
    expect(result.violations).toContain("99999.99");
  });

  it("keeps an LLM brief whose figures all came from the report", async () => {
    const client = {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Claimable now: 5.260525213286241524 WETH ($10083.61)." }],
        }),
      },
    };
    const result = await writeBrief(report, { client: client as never });
    expect(result.origin).toBe("llm");
    expect(result.violations).toEqual([]);
  });

  it("falls back when the model refuses", async () => {
    const client = {
      messages: { create: async () => ({ stop_reason: "refusal", content: [] }) },
    };
    const result = await writeBrief(report, { client: client as never });
    expect(result.origin).toBe("deterministic");
  });
});

describe("deterministicBrief", () => {
  it("labels the total as covering priced items only", () => {
    expect(deterministicBrief(report)).toContain("across priced items only");
  });

  it("marks unpriced items as unpriced rather than $0", () => {
    expect(deterministicBrief(report)).toContain("(unpriced)");
  });

  it("names sources that could not be read", () => {
    const withError: ScanReport = {
      ...report,
      errors: [{ source: "merkl", stage: "scan", message: "API 503" }],
    };
    expect(deterministicBrief(withError)).toContain("Could not read merkl");
  });
});
