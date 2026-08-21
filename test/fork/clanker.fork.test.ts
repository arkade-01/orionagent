import type { ChildProcess } from "node:child_process";
import { getAddress, type Address } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clankerFeeLockerAbi } from "../../src/abis/clankerFeeLocker.js";
import { erc20Abi } from "../../src/abis/erc20.js";
import { ClankerAdapter } from "../../src/adapters/clanker.js";
import { chainScanClanker } from "../../src/chainscan.js";
import { ADDRESSES } from "../../src/config.js";
import { clearTokenCache } from "../../src/tokens.js";
import type { ScanContext } from "../../src/types.js";
import { forkClients, forkRpcUrl, fundedImpersonation, skipWithReason, startAnvil } from "./anvil.js";

/**
 * A caller that is deliberately NOT the fee owner. Not a well-known address —
 * the burn address, for one, already holds real token balances on Base, which
 * would muddy the "the caller received nothing" assertion.
 */
const STRANGER = "0x00000000000000000000000000000000c1a1e575" as const;

const hasFork = forkRpcUrl() !== null;
let anvil: ChildProcess | null = null;

describe.skipIf(!hasFork)("clanker (Base fork)", () => {
  let owner: Address | null = null;
  let currency: Address;
  let expected: bigint;
  let unavailable: string | null = null;

  beforeAll(async () => {
    anvil = await startAnvil();
    if (!anvil) {
      unavailable = "anvil could not be started";
      return;
    }
    clearTokenCache();

    // Find a live fee owner rather than pinning an address that will be drained.
    try {
      const { public: client } = forkClients();
      const scan = await chainScanClanker(client, { lookbackBlocks: 4000n, maxPairs: 120 });
      const lead = scan.leads.find((l) => l.rawAmount > 0n);
      if (!lead) {
        unavailable = "no wallet with unclaimed Clanker fees in the lookback window";
        return;
      }
      owner = lead.recipient;
      currency = getAddress(lead.token.address);
      expected = lead.rawAmount;
    } catch (err) {
      // Rate limits and upstream timeouts are not test failures — they mean the
      // assertion never ran. Skip loudly instead of passing quietly.
      unavailable = `target discovery failed: ${(err as Error).message.split("\n")[0]}`;
    }
  }, 180_000);

  afterAll(() => anvil?.kill());

  it("read == received: availableFees matches the transfer a claim produces", async (t) => {
    if (!owner) return skipWithReason(t, unavailable ?? "no target");
    const { public: client, wallet } = forkClients();

    const balance = async (address: Address) =>
      (await client.readContract({
        address: currency,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      })) as bigint;

    const before = await balance(owner);
    const strangerBefore = await balance(STRANGER);

    const available = (await client.readContract({
      address: ADDRESSES.clankerFeeLocker,
      abi: clankerFeeLockerAbi,
      functionName: "availableFees",
      args: [owner, currency],
    })) as bigint;
    expect(available).toBe(expected);
    expect(available).toBeGreaterThan(0n);

    // Submitted by a stranger — this is the permissionless property under test.
    await fundedImpersonation(STRANGER);
    const hash = await wallet.writeContract({
      account: STRANGER,
      chain: null,
      address: ADDRESSES.clankerFeeLocker,
      abi: clankerFeeLockerAbi,
      functionName: "claim",
      args: [owner, currency],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");

    // The claim landed in the OWNER's wallet, not the caller's, and it was
    // exactly what the read promised.
    expect((await balance(owner)) - before).toBe(available);
    expect((await balance(STRANGER)) - strangerBefore).toBe(0n);

    const remaining = (await client.readContract({
      address: ADDRESSES.clankerFeeLocker,
      abi: clankerFeeLockerAbi,
      functionName: "availableFees",
      args: [owner, currency],
    })) as bigint;
    expect(remaining).toBe(0n);
  }, 180_000);

  it("the adapter's claim tx produces that same transfer", async (t) => {
    if (!owner) return skipWithReason(t, unavailable ?? "no target");
    const { public: client, wallet } = forkClients();
    const ctx: ScanContext = {
      owner,
      chainId: 8453,
      blockNumber: await client.getBlockNumber(),
    };

    const adapter = new ClankerAdapter(client);
    const { items } = await adapter.scan(ctx);
    const item = items.find((i) => i.token.address.toLowerCase() === currency.toLowerCase());
    // The owner reached us via chain-scan; the adapter enumerates from the
    // deployer index, which does not cover split recipients.
    if (!item) return skipWithReason(t, "owner is not in the Clanker deployer index");

    const before = (await client.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;

    const txs = await adapter.buildClaim(ctx, [item]);
    await fundedImpersonation(STRANGER);
    for (const tx of txs) {
      const hash = await wallet.sendTransaction({
        account: STRANGER,
        chain: null,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      });
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe("success");
    }

    const after = (await client.readContract({
      address: currency,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
    expect(after - before).toBe(item.rawAmount);
  }, 240_000);
});
