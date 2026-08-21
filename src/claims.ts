import type { Hash, PublicClient, WalletClient } from "viem";
import type { ClaimTx } from "./types.js";

export interface ExecutionResult {
  tx: ClaimTx;
  status: "sent" | "skipped" | "failed";
  hash?: Hash;
  reason?: string;
}

/**
 * Submit only the permissionless txs, from the agent signer.
 *
 * The agent pays gas; where the funds land is fixed by the contracts
 * (`claim(feeOwner, ...)` transfers to the fee owner, Merkl's `claim` credits
 * `users[i]`), not by anything here. owner-sign txs are never submitted — they
 * are returned for the owner's wallet.
 */
export async function executePermissionless(
  publicClient: PublicClient,
  wallet: WalletClient,
  txs: ClaimTx[],
  opts: { waitForReceipt?: boolean } = {},
): Promise<ExecutionResult[]> {
  const account = wallet.account;
  if (!account) throw new Error("Agent wallet has no account configured.");

  const results: ExecutionResult[] = [];
  // Sequential: prerequisite sweeps must land before the claim that reads them.
  for (const tx of txs) {
    if (tx.claimType !== "permissionless") {
      results.push({ tx, status: "skipped", reason: "owner-sign — returned for the owner to sign" });
      continue;
    }
    try {
      const hash = await wallet.sendTransaction({
        account,
        chain: wallet.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      if (opts.waitForReceipt !== false) {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          results.push({ tx, status: "failed", hash, reason: "reverted" });
          continue;
        }
      }
      results.push({ tx, status: "sent", hash });
    } catch (err) {
      results.push({ tx, status: "failed", reason: (err as Error).message });
    }
  }
  return results;
}

/** Owner-sign txs, shaped for a wallet's `sendTransaction`. */
export function toOwnerSignRequests(txs: ClaimTx[]) {
  return txs
    .filter((t) => t.claimType === "owner-sign")
    .map((t) => ({
      to: t.to,
      data: t.data,
      value: `0x${t.value.toString(16)}`,
      chainId: t.chainId,
      description: t.description,
    }));
}
