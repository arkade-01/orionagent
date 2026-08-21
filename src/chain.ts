import { createPublicClient, createWalletClient, http, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE_CHAIN_ID, loadConfig } from "./config.js";

export type BaseClient = PublicClient;

export function createBaseClient(rpcUrl?: string): PublicClient {
  const url = rpcUrl ?? loadConfig().rpcUrl;
  return createPublicClient({
    chain: base,
    transport: http(url, { batch: true }),
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
    transport: http(url),
  });
}

export async function assertBaseChain(client: PublicClient): Promise<void> {
  const id = await client.getChainId();
  if (id !== BASE_CHAIN_ID) {
    throw new Error(`Connected to chainId ${id}; Orionscope only supports Base (${BASE_CHAIN_ID}).`);
  }
}
