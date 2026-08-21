import type { ChildProcess } from "node:child_process";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { erc20Abi } from "../../src/abis/erc20.js";
import { merklDistributorAbi } from "../../src/abis/merklDistributor.js";
import { MerklAdapter, fetchMerklClaimables, type MerklClaimable } from "../../src/adapters/merkl.js";
import { ADDRESSES } from "../../src/config.js";
import { clearTokenCache } from "../../src/tokens.js";
import type { ScanContext } from "../../src/types.js";
import {
  forkClients,
  forkRpcUrl,
  fundedImpersonation,
  skipWithReason,
  startAnvil,
  widenUntilFound,
} from "./anvil.js";

const STRANGER = "0x000000000000000000000000000000000000dEaD" as const;
const hasFork = forkRpcUrl() !== null;
let anvil: ChildProcess | null = null;

/**
 * Merkl has no "who has rewards" endpoint, so walk recent `Claimed` events and
 * ask the API about each claimer until one still has something outstanding.
 */
async function findClaimableUser(): Promise<{ user: Address; claimable: MerklClaimable } | null> {
  const { public: client } = forkClients();
  const head = await client.getBlockNumber();
  return widenUntilFound([2000n, 9000n], (span) => searchWindow(head - span, head));
}

async function searchWindow(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ user: Address; claimable: MerklClaimable } | null> {
  const { public: client } = forkClients();
  const logs = await client.getContractEvents({
    address: ADDRESSES.merklDistributor,
    abi: merklDistributorAbi,
    eventName: "Claimed",
    fromBlock,
    toBlock,
  });

  const users = [...new Set(logs.map((l) => (l.args as { user?: Address }).user).filter(Boolean))].slice(
    0,
    25,
  ) as Address[];

  for (const user of users) {
    try {
      const { claimables } = await fetchMerklClaimables(user);
      const claimable = claimables.find((c) => c.claimableAmount > 0n);
      if (claimable) return { user, claimable };
    } catch {
      continue;
    }
  }
  return null;
}

describe.skipIf(!hasFork)("merkl (Base fork)", () => {
  let target: { user: Address; claimable: MerklClaimable } | null = null;
  let unavailable: string | null = null;

  beforeAll(async () => {
    anvil = await startAnvil();
    if (!anvil) {
      unavailable = "anvil could not be started";
      return;
    }
    clearTokenCache();
    try {
      target = await findClaimableUser();
      if (!target) unavailable = "no recent Merkl claimer with an outstanding balance";
    } catch (err) {
      unavailable = `target discovery failed: ${(err as Error).message.split("\n")[0]}`;
    }
  }, 240_000);

  afterAll(() => anvil?.kill());

  // Runs first: it only produces a reverting tx, so it leaves the fork's
  // balances untouched for the claim test below. The other order would drain
  // the wallet and leave this one with nothing to try.
  it("an unapproved third party cannot claim on the owner's behalf", async (t) => {
    if (!target) return skipWithReason(t, unavailable ?? "no target");
    const { user } = target;
    const { public: client, wallet } = forkClients();

    const ctx: ScanContext = { owner: user, chainId: 8453, blockNumber: await client.getBlockNumber() };
    const adapter = new MerklAdapter(client);
    const { items, notes } = await adapter.scan(ctx);
    if (items.length === 0) return skipWithReason(t, "already drained by the previous test");

    // No agent operator approval exists, so the adapter must say owner-sign.
    expect(items.every((i) => i.claimType === "owner-sign")).toBe(true);
    expect(notes?.some((n) => n.message.includes("toggleOperator"))).toBe(true);

    const txs = await adapter.buildClaim(ctx, items);
    await fundedImpersonation(STRANGER);

    // Anvil accepts the tx and mines it; the Distributor rejects it on-chain
    // with NotWhitelisted, so the proof is in the receipt, not the send.
    const hash = await wallet.sendTransaction({
      account: STRANGER,
      chain: null,
      to: txs[0]!.to,
      data: txs[0]!.data,
      value: txs[0]!.value,
      gas: 3_000_000n,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("reverted");
  }, 240_000);

  it("read == received: the reported amount is what the claim transfers", async (t) => {
    if (!target) return skipWithReason(t, unavailable ?? "no target");
    const { user, claimable } = target;
    const { public: client, wallet } = forkClients();
    const rewardToken = getAddress(claimable.token.address);

    const ctx: ScanContext = { owner: user, chainId: 8453, blockNumber: await client.getBlockNumber() };
    const adapter = new MerklAdapter(client);
    const { items } = await adapter.scan(ctx);
    const item = items.find(
      (i) => String(i.meta?.rewardToken).toLowerCase() === rewardToken.toLowerCase(),
    );
    // The chain says it was already claimed; there is nothing to assert.
    if (!item) return skipWithReason(t, "nothing outstanding on-chain for this user");

    // The reported amount comes from the contract's `claimed`, not the API's,
    // so it is what a claim actually transfers even when the API index lags.
    expect(item.rawAmount).toBeGreaterThan(0n);

    // Measure the token the report NAMES. For a wrapped campaign that is the
    // underlying, which is the whole point — the wrapper burns itself on
    // receipt, so watching its balance would always show zero.
    const balance = async (address: Address) =>
      (await client.readContract({
        address: getAddress(item.token.address),
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;
    const before = await balance(user);
    // Only assert the destination when the user has not redirected their payout.
    if ((item.meta?.recipient as string)?.toLowerCase() !== user.toLowerCase()) {
      return skipWithReason(t, "this user redirected their payout via claimRecipient");
    }

    const txs = await adapter.buildClaim(ctx, items);
    expect(txs).toHaveLength(1);

    // Sent by the user: the Distributor rejects unapproved third parties, which
    // is why this source is owner-sign.
    await fundedImpersonation(user);
    const hash = await wallet.sendTransaction({
      account: user,
      chain: null,
      to: txs[0]!.to,
      data: txs[0]!.data,
      value: txs[0]!.value,
    });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");

    expect((await balance(user)) - before).toBe(item.rawAmount);
  }, 240_000);
});
