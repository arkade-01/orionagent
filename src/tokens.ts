import type { Address, PublicClient } from "viem";
import { erc20Abi } from "./abis/erc20.js";
import type { TokenInfo } from "./types.js";

const cache = new Map<string, TokenInfo>();

/**
 * Reads symbol/name/decimals on-chain. Decimals are required for USD display, so
 * a token whose `decimals` cannot be read is treated as 18 ONLY for display; the
 * raw amount is untouched either way. Symbol/name fall back to null, never to a
 * made-up string.
 */
export async function loadTokenInfo(
  client: PublicClient,
  addresses: Address[],
  blockNumber?: bigint,
): Promise<Map<string, TokenInfo>> {
  const wanted = [...new Set(addresses.map((a) => a.toLowerCase() as Address))].filter(
    (a) => !cache.has(a),
  );

  if (wanted.length > 0) {
    const contracts = wanted.flatMap((address) => [
      { address, abi: erc20Abi, functionName: "symbol" } as const,
      { address, abi: erc20Abi, functionName: "name" } as const,
      { address, abi: erc20Abi, functionName: "decimals" } as const,
    ]);
    const results = await client.multicall({ contracts, allowFailure: true, blockNumber });

    wanted.forEach((address, i) => {
      const symbol = results[i * 3];
      const name = results[i * 3 + 1];
      const decimals = results[i * 3 + 2];
      cache.set(address, {
        address,
        symbol: symbol?.status === "success" ? (symbol.result as string) : null,
        name: name?.status === "success" ? (name.result as string) : null,
        decimals: decimals?.status === "success" ? Number(decimals.result) : 18,
      });
    });
  }

  const out = new Map<string, TokenInfo>();
  for (const a of addresses) {
    const key = a.toLowerCase();
    const info = cache.get(key);
    if (info) out.set(key, { ...info, address: a });
  }
  return out;
}

/** Test seam — the module-level cache would otherwise leak between fork tests. */
export function clearTokenCache(): void {
  cache.clear();
}

export function formatAmount(raw: bigint, token: TokenInfo): string {
  const base = 10n ** BigInt(token.decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(token.decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
