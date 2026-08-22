import { describe, expect, it, vi } from "vitest";
import { executePermissionless, toOwnerSignRequests } from "../../src/claims.js";
import type { ClaimTx } from "../../src/types.js";

const AGENT = "0x2222222222222222222222222222222222222222" as const;

function tx(over: Partial<ClaimTx> = {}): ClaimTx {
  return {
    to: "0x3333333333333333333333333333333333333333",
    data: "0xdeadbeef",
    value: 0n,
    chainId: 8453,
    claimType: "permissionless",
    description: "claim",
    itemIds: ["x"],
    ...over,
  };
}

const receiptOk = { status: "success" as const };

describe("executePermissionless", () => {
  it("never submits an owner-sign tx", async () => {
    const wallet = { account: { address: AGENT }, sendTransaction: vi.fn() };
    const results = await executePermissionless(
      {} as never,
      wallet as never,
      [tx({ claimType: "owner-sign" })],
    );
    expect(results[0]!.status).toBe("skipped");
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("pre-flights, and does not spend gas on a tx that would revert", async () => {
    const publicClient = {
      call: vi.fn(async () => {
        const err = new Error("execution reverted") as Error & { shortMessage?: string };
        err.shortMessage = "execution reverted: NoFeesToClaim()";
        throw err;
      }),
    };
    const wallet = { account: { address: AGENT }, sendTransaction: vi.fn() };

    const results = await executePermissionless(publicClient as never, wallet as never, [tx()]);
    expect(results[0]!.status).toBe("skipped");
    expect(results[0]!.reason).toContain("NoFeesToClaim");
    // The whole point: no transaction was broadcast.
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("sends when the pre-flight passes", async () => {
    const publicClient = {
      call: vi.fn(async () => ({ data: "0x" })),
      waitForTransactionReceipt: vi.fn(async () => receiptOk),
    };
    const wallet = { account: { address: AGENT }, sendTransaction: vi.fn(async () => "0xhash") };

    const results = await executePermissionless(publicClient as never, wallet as never, [tx()]);
    expect(results[0]!.status).toBe("sent");
    expect(results[0]!.hash).toBe("0xhash");
  });

  it("reports a revert that only shows up in the receipt", async () => {
    const publicClient = {
      call: vi.fn(async () => ({ data: "0x" })),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" as const })),
    };
    const wallet = { account: { address: AGENT }, sendTransaction: vi.fn(async () => "0xhash") };

    const results = await executePermissionless(publicClient as never, wallet as never, [tx()]);
    expect(results[0]!.status).toBe("failed");
    expect(results[0]!.reason).toBe("reverted");
  });

  it("collapses a sprawling viem error into one line", async () => {
    const noisy = new Error(
      "The contract function reverted.\n\nRequest body: {...500 chars...}\nDocs: https://viem.sh\nVersion: viem@2",
    ) as Error & { shortMessage?: string };
    noisy.shortMessage = "The contract function reverted.";
    const publicClient = { call: vi.fn(async () => { throw noisy; }) };
    const wallet = { account: { address: AGENT }, sendTransaction: vi.fn() };

    const results = await executePermissionless(publicClient as never, wallet as never, [tx()]);
    expect(results[0]!.reason?.split("\n")).toHaveLength(1);
  });
});

describe("toOwnerSignRequests", () => {
  it("returns only the txs the owner must sign", () => {
    const requests = toOwnerSignRequests([tx(), tx({ claimType: "owner-sign" })]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.value).toBe("0x0");
  });
});
