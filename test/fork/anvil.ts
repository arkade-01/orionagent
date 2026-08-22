import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type Address,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { base } from "viem/chains";

export const ANVIL_PORT = Number(process.env.ANVIL_PORT ?? 8546);
export const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

export function forkRpcUrl(): string | null {
  return process.env.FORK_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim() || null;
}

/**
 * Boots an Anvil fork of Base mainnet. Returns null when there is no RPC to fork
 * from or anvil is not installed, so the fork suites can skip instead of fail.
 */
export async function startAnvil(blockNumber?: bigint): Promise<ChildProcess | null> {
  const rpc = forkRpcUrl();
  if (!rpc) return null;

  const args = ["--fork-url", rpc, "--port", String(ANVIL_PORT), "--silent"];
  if (blockNumber !== undefined) args.push("--fork-block-number", blockNumber.toString());

  let child: ChildProcess;
  try {
    child = spawn("anvil", args, { stdio: "ignore" });
  } catch {
    return null;
  }

  // spawn reports a missing binary asynchronously via an 'error' event, not by
  // throwing. Without this the poll loop below waits the full 60s to discover
  // that anvil was never installed.
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
  });
  if (child.exitCode !== null) return null;

  const client = createPublicClient({ chain: base, transport: http(ANVIL_URL, { timeout: 120_000 }) });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnFailed || child.exitCode !== null) return null;
    try {
      await client.getBlockNumber();
      return child;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  child.kill();
  return null;
}

export interface ForkClients {
  public: PublicClient;
  test: TestClient;
  wallet: WalletClient;
}

export function forkClients(): ForkClients {
  // A forked node fetches state lazily from the upstream RPC, so a proof-heavy
  // call can take far longer than viem's 10s default.
  const transport = http(ANVIL_URL, { timeout: 120_000 });
  return {
    public: createPublicClient({ chain: base, transport }) as PublicClient,
    test: createTestClient({ chain: base, mode: "anvil", transport }) as TestClient,
    wallet: createWalletClient({ chain: base, transport }) as WalletClient,
  };
}

/** Impersonate `address` with enough ETH to pay gas. */
export async function fundedImpersonation(address: Address): Promise<void> {
  const { test } = forkClients();
  await test.impersonateAccount({ address });
  await test.setBalance({ address, value: 10n ** 18n });
}

/**
 * Skip a fork test and say why on stderr.
 *
 * A skip is not a pass. These suites depend on live chain state and third-party
 * APIs, so "no target could be found" and "the price API timed out" are real
 * outcomes — but they mean the assertion never ran, and that has to be visible
 * rather than hidden behind a green check.
 */
export function skipWithReason(t: { skip: () => void }, reason: string): void {
  console.warn(`  ↓ skipped — ${reason}`);
  t.skip();
}

/**
 * Try each lookback window in turn, widening until something is found.
 *
 * Fork-test discovery walks event logs on a public RPC, which rate-limits wide
 * `eth_getLogs` spans unpredictably — the same 9k-block query succeeds one
 * minute and errors the next. Starting narrow keeps the common case cheap, and
 * treating an error as "try the next window" keeps a rate limit from being
 * mistaken for "there is nothing on chain".
 */
export async function widenUntilFound<T>(
  spans: readonly bigint[],
  attempt: (span: bigint) => Promise<T | null>,
): Promise<T | null> {
  let lastError: Error | null = null;
  for (const span of spans) {
    try {
      const found = await attempt(span);
      if (found) return found;
    } catch (err) {
      lastError = err as Error;
    }
  }
  if (lastError) throw lastError;
  return null;
}
