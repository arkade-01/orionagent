import { describe, expect, it } from "vitest";
import { fetchPrices, toUsdValue } from "../../src/pricing.js";
import type { TokenInfo } from "../../src/types.js";

const WETH = "0x4200000000000000000000000000000000000006" as const;
const THIN = "0x00000000000000000000000000000000000000ff" as const;

function stubFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

const token: TokenInfo = { address: WETH, symbol: "WETH", name: "Wrapped Ether", decimals: 18 };

describe("pricing", () => {
  it("prices a token the API returns with high confidence", async () => {
    const prices = await fetchPrices(
      [WETH],
      stubFetch({ coins: { [`base:${WETH}`]: { price: 2000, confidence: 0.99 } } }),
    );
    expect(prices.get(WETH)?.usdPerToken).toBe(2000);
  });

  it("returns null for a token the API omits — never a guess", async () => {
    const prices = await fetchPrices([THIN], stubFetch({ coins: {} }));
    expect(prices.get(THIN)?.usdPerToken).toBeNull();
  });

  it("returns null for a low-confidence price on a thin token", async () => {
    const prices = await fetchPrices(
      [THIN],
      stubFetch({ coins: { [`base:${THIN}`]: { price: 0.42, confidence: 0.4 } } }),
    );
    expect(prices.get(THIN)?.usdPerToken).toBeNull();
    expect(prices.get(THIN)?.confidence).toBe(0.4);
  });

  it("returns null when the price API is unreachable, and says why", async () => {
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const prices = await fetchPrices([WETH], failing);
    expect(prices.get(WETH)?.usdPerToken).toBeNull();
    // A reachable API that simply has no price for a thin token is a different
    // fact from a price API we could not reach, and the report says which.
    expect(prices.get(WETH)?.status).toBe("lookup-failed");
  });

  it("distinguishes a thin token from a failed lookup", async () => {
    const thin = await fetchPrices([THIN], stubFetch({ coins: {} }));
    expect(thin.get(THIN)?.status).toBe("no-reliable-price");

    const http500 = await fetchPrices([THIN], stubFetch({}, false));
    expect(http500.get(THIN)?.status).toBe("lookup-failed");
  });

  it("yields usdValue null whenever the price is null", () => {
    expect(toUsdValue(10n ** 18n, token, undefined)).toBeNull();
    expect(
      toUsdValue(10n ** 18n, token, {
        usdPerToken: null,
        status: "no-reliable-price",
        confidence: null,
        source: "x",
        fetchedAt: "",
      }),
    ).toBeNull();
  });

  it("converts base units with the token's decimals", () => {
    const usd = toUsdValue(
      5_260_525_213_286_241_524n,
      token,
      { usdPerToken: 1000, status: "priced", confidence: 1, source: "x", fetchedAt: "" },
    );
    expect(usd).toBeCloseTo(5260.525213286242, 6);
  });
});
