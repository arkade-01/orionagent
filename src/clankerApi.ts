import { getAddress, type Address } from "viem";
import { API, BASE_CHAIN_ID } from "./config.js";

/** Subset of the clanker.world token record we actually rely on. */
export interface ClankerToken {
  contract_address: Address;
  name?: string;
  symbol?: string;
  /** e.g. "clanker_v4". Anything else is a legacy deploy with a different claim path. */
  type?: string;
  chain_id?: number;
  admin?: Address;
  msg_sender?: Address;
  factory_address?: Address;
  locker_address?: Address;
  deployed_at?: string;
  priceUsd?: number;
  pool_config?: { pairedToken?: Address };
  extensions?: {
    fees?: {
      recipients?: { bps: number; admin: Address; recipient: Address }[];
    };
  };
  related?: { market?: { marketCap?: number; volume24h?: number } };
}

interface TokenListResponse {
  data?: ClankerToken[];
  total?: number;
}

/** The API rejects `limit` above 20 with a 400. */
const MAX_PAGE_LIMIT = 20;

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Clanker API ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export function isV4(token: ClankerToken): boolean {
  return token.type === "clanker_v4";
}

export function isOnBase(token: ClankerToken): boolean {
  return token.chain_id === undefined || token.chain_id === BASE_CHAIN_ID;
}

/** Reward recipients as the API reports them, lowercased. */
export function apiRewardRecipients(token: ClankerToken): string[] {
  return (token.extensions?.fees?.recipients ?? []).map((r) => r.recipient.toLowerCase());
}

/**
 * Tokens deployed by `address`.
 *
 * Caveat worth knowing: this indexes the DEPLOYER, so it misses tokens where the
 * wallet is only a split reward recipient on someone else's deploy. Pass those
 * token addresses explicitly (`--token`) or index deploy events to cover them.
 */
export async function fetchTokensDeployedBy(
  address: Address,
  opts: { maxPages?: number; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ tokens: ClankerToken[]; url: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.min(opts.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const maxPages = opts.maxPages ?? 10;
  const base = `${API.clanker}/tokens/fetch-deployed-by-address?address=${getAddress(address)}`;

  const tokens: ClankerToken[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}&page=${page}&limit=${limit}`;
    const body = await getJson<TokenListResponse>(url, fetchImpl);
    const batch = body.data ?? [];
    tokens.push(...batch);
    if (batch.length < limit) break;
  }
  return { tokens, url: base };
}

/** Recently deployed tokens — the universe the chain-scan ranks over. */
export async function fetchRecentTokens(
  opts: { pages?: number; limit?: number; fetchImpl?: typeof fetch } = {},
): Promise<{ tokens: ClankerToken[]; url: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const limit = Math.min(opts.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
  const pages = opts.pages ?? 4;
  const tokens: ClankerToken[] = [];
  for (let page = 1; page <= pages; page++) {
    const url = `${API.clanker}/tokens?page=${page}&limit=${limit}`;
    const body = await getJson<TokenListResponse>(url, fetchImpl);
    const batch = body.data ?? [];
    tokens.push(...batch);
    if (batch.length < limit) break;
  }
  return { tokens, url: `${API.clanker}/tokens` };
}
