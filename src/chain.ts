import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE_CHAIN_ID, loadConfig } from "./config.js";

export type BaseClient = PublicClient;

/**
 * Public Base RPCs rate-limit under the read volume a full scan generates, and a
 * throttled read would otherwise surface as "this source could not be read" —
 * indistinguishable, to the reader, from "you have nothing here". Retry with
 * backoff so a transient 429 does not silently become a zero.
 */
const RPC_RETRY = { retryCount: 5, retryDelay: 300 } as const;

export function createBaseClient(rpcUrl?: string): PublicClient {
  const url = rpcUrl ?? loadConfig().rpcUrl;
  return createPublicClient({
    chain: base,
    transport: http(url, { batch: true, ...RPC_RETRY }),
    batch: { multicall: true },
  }) as PublicClient;
}

/**
 * Signer for permissionless claims only. It pays gas; the destination of the
 * funds is fixed by the contract (the owner), never by this key. Returns null
 * when unconfigured, which puts the CLI in build-only mode.
 */
export function createAgentWallet(
  rpcUrl?: string,
  privateKey = process.env.AGENT_PRIVATE_KEY,
): WalletClient | null {
  const key = privateKey?.trim();
  if (!key) return null;
  const url = rpcUrl ?? loadConfig().rpcUrl;
  return createWalletClient({
    account: privateKeyToAccount(key as `0x${string}`),
    chain: base,
    transport: http(url, RPC_RETRY),
  });
}

/**
 * Turn an unusable-RPC failure into a sentence the reader can act on.
 *
 * Two things made this necessary. viem's batching crashes with
 * "Cannot read properties of undefined (reading 'error')" when a provider
 * answers a whole batch with a single error object — which is exactly what
 * Alchemy does on a 429 — so the surfaced message described a TypeError in
 * viem rather than the rate limit that caused it. And because the preflight
 * runs before any adapter, a throttled key killed the entire command with that
 * message instead of reporting a per-source failure.
 */
function describeRpcFailure(err: unknown, url: string): string {
  const e = err as { details?: string; shortMessage?: string; message?: string; status?: number };
  const text = `${e?.status ?? ""} ${e?.details ?? ""} ${e?.shortMessage ?? ""} ${e?.message ?? ""}`.toLowerCase();
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();

  if (text.includes("rate limit") || text.includes("429") || text.includes("too many requests")) {
    return (
      `${host} is rate-limiting every request, including a plain eth_blockNumber. ` +
      `Nothing can be read through it right now. Wait for the limit to clear, or use an endpoint ` +
      `with guaranteed throughput — a deep scan alone issues ~1900 requests.`
    );
  }
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden")) {
    return `${host} rejected the credentials in BASE_RPC_URL. Check the key is current and allowed to serve Base.`;
  }
  if (text.includes("cannot read properties of undefined")) {
    return (
      `${host} returned a response viem could not parse. This is usually a provider-side error ` +
      `answered as a single object rather than per-request. Try again, or switch endpoints.`
    );
  }
  if (text.includes("fetch failed") || text.includes("enotfound") || text.includes("econnrefused")) {
    return `Could not reach ${host}. Check the URL in BASE_RPC_URL and your network.`;
  }
  return `${host} could not be reached: ${e?.shortMessage ?? e?.message ?? String(err)}`;
}

/**
 * Preflight the RPC before any adapter runs.
 *
 * Deliberately a raw fetch rather than a viem client: viem retries a 429 and
 * then reports the exhausted retries as a timeout, so the actionable cause
 * ("your key is throttled") gets replaced by a symptom ("too slow"). Reading the
 * HTTP status and error body directly keeps the real reason.
 */
export async function assertBaseChain(client: PublicClient, rpcUrl?: string): Promise<void> {
  const url = rpcUrl ?? loadConfig().rpcUrl;

  let status: number;
  let body: { result?: string; error?: { message?: string } };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new Error(describeRpcFailure(err, url));
  }

  if (status === 429 || body.error) {
    throw new Error(
      describeRpcFailure({ status, details: body.error?.message ?? `HTTP ${status}` }, url),
    );
  }
  if (status < 200 || status >= 300 || !body.result) {
    throw new Error(describeRpcFailure({ status, details: `HTTP ${status}` }, url));
  }

  const id = Number(BigInt(body.result));
  if (id !== BASE_CHAIN_ID) {
    throw new Error(`Connected to chainId ${id}; Orionscope only supports Base (${BASE_CHAIN_ID}).`);
  }
}
