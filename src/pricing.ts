import type { Address } from "viem";
import { API, MIN_PRICE_CONFIDENCE } from "./config.js";
import { retryingFetch } from "./http.js";
import type { PriceInfo, PriceStatus, TokenInfo } from "./types.js";

interface LlamaCoin {
  decimals?: number;
  symbol?: string;
  price?: number;
  timestamp?: number;
  confidence?: number;
}

const CHUNK = 40;

/**
 * Batch price lookup against DefiLlama.
 *
 * A token is priced only when the API returns a finite, positive price with
 * confidence at or above MIN_PRICE_CONFIDENCE. Everything else — missing entry,
 * low confidence, request failure — comes back as `usdPerToken: null`, which the
 * report surfaces as "unpriced". Never invent a price for a thin token.
 */
export async function fetchPrices(
  tokens: Address[],
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, PriceInfo>> {
  const doFetch = retryingFetch(fetchImpl === fetch ? undefined : fetchImpl);
  const out = new Map<string, PriceInfo>();
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const fetchedAt = new Date().toISOString();

  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const url = `${API.prices}/prices/current/${batch.map((t) => `base:${t}`).join(",")}`;
    let coins: Record<string, LlamaCoin> = {};
    let reachable = true;
    try {
      const res = await doFetch(url);
      if (res.ok) coins = ((await res.json()) as { coins?: Record<string, LlamaCoin> }).coins ?? {};
      else reachable = false;
    } catch {
      // Leave the batch unpriced rather than guessing — but remember why, so the
      // report can say "we could not check" instead of implying the token is thin.
      reachable = false;
    }

    for (const token of batch) {
      const coin = coins[`base:${token}`];
      const confidence = coin?.confidence ?? null;
      const priced =
        coin?.price !== undefined &&
        Number.isFinite(coin.price) &&
        coin.price > 0 &&
        (confidence === null || confidence >= MIN_PRICE_CONFIDENCE);

      const status: PriceStatus = priced
        ? "priced"
        : reachable
          ? "no-reliable-price"
          : "lookup-failed";

      out.set(token, {
        usdPerToken: priced ? (coin!.price as number) : null,
        status,
        confidence,
        source: `${API.prices}/prices/current/base:${token}`,
        fetchedAt,
      });
    }
  }

  return out;
}

/**
 * USD value of a raw base-unit amount. Display and ranking only — claim logic
 * always uses `rawAmount`. Returns null whenever the price is not trustworthy.
 */
export function toUsdValue(
  rawAmount: bigint,
  token: TokenInfo,
  price: PriceInfo | undefined,
): number | null {
  if (!price || price.usdPerToken === null) return null;
  const whole = Number(rawAmount) / 10 ** token.decimals;
  if (!Number.isFinite(whole)) return null;
  const usd = whole * price.usdPerToken;
  return Number.isFinite(usd) ? usd : null;
}
