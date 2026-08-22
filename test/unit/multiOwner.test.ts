import { describe, expect, it } from "vitest";
import { scanWallets } from "../../src/engine.js";
import type { Address } from "viem";

const EOA = "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" as Address;
const SAFE = "0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55" as Address;
const WETH = "0x4200000000000000000000000000000000000006";

/**
 * NPM stub: `positionsByOwner` decides who holds what, so we can model a
 * position that lives in a Safe rather than in the user's EOA.
 */
function client(positionsByOwner: Record<string, bigint[]>) {
  const owed = 1_000_000_000_000_000_000n;
  return {
    getBlockNumber: async () => 50_000_000n,
    readContract: async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      if (functionName === "balanceOf") {
        return BigInt((positionsByOwner[String(args[0]).toLowerCase()] ?? []).length);
      }
      throw new Error(`unstubbed ${functionName}`);
    },
    multicall: async ({ contracts }: { contracts: { functionName: string; args?: readonly unknown[] }[] }) =>
      contracts.map((c) => {
        if (c.functionName === "tokenOfOwnerByIndex") {
          const ids = positionsByOwner[String(c.args?.[0]).toLowerCase()] ?? [];
          return { status: "success", result: ids[Number(c.args?.[1])] };
        }
        if (c.functionName === "positions") {
          return {
            status: "success",
            result: [0n, WETH, WETH, WETH, 3000, 0, 0, 0n, 0n, 0n, 0n, 0n],
          };
        }
        if (c.functionName === "symbol") return { status: "success", result: "WETH" };
        if (c.functionName === "name") return { status: "success", result: "Wrapped Ether" };
        if (c.functionName === "decimals") return { status: "success", result: 18 };
        return { status: "failure", error: new Error("unstubbed") };
      }),
    simulateContract: async () => ({ result: [owed, 0n] }),
    getLogs: async () => [],
    getContractEvents: async () => [],
  } as never;
}

const options = {
  sources: ["uniswap-v3" as const],
  fetchImpl: (async () => ({ ok: true, json: async () => ({ coins: {} }) })) as never,
};

describe("scanWallets", () => {
  it("finds a position the EOA cannot see because a Safe holds it", async () => {
    // The gap this closes: the position is real and the fees are real, but
    // `balanceOf(EOA)` is 0 because the NFT belongs to the Safe.
    const eoaOnly = await scanWallets(client({ [SAFE.toLowerCase()]: [1n] }), [EOA], options);
    expect(eoaOnly.items).toHaveLength(0);

    const both = await scanWallets(client({ [SAFE.toLowerCase()]: [1n] }), [EOA, SAFE], options);
    expect(both.items.length).toBeGreaterThan(0);
  });

  it("records the holder on each item, since that is who must sign", async () => {
    const report = await scanWallets(client({ [SAFE.toLowerCase()]: [1n] }), [EOA, SAFE], options);
    expect(report.items[0]!.owner).toBe(SAFE);
    // The report's headline address stays the human's wallet.
    expect(report.owner).toBe(EOA);
  });

  it("pins every address to one block so the merged report is one snapshot", async () => {
    const report = await scanWallets(
      client({ [EOA.toLowerCase()]: [1n], [SAFE.toLowerCase()]: [2n] }),
      [EOA, SAFE],
      options,
    );
    expect(report.blockNumber).toBe(50_000_000n);
    expect(new Set(report.items.map((i) => i.owner)).size).toBe(2);
  });

  it("totals across every address", async () => {
    const report = await scanWallets(
      client({ [EOA.toLowerCase()]: [1n], [SAFE.toLowerCase()]: [2n] }),
      [EOA, SAFE],
      options,
    );
    expect(report.totals.itemCount).toBe(report.items.length);
    expect(report.totals.itemCount).toBeGreaterThan(1);
  });

  it("says which addresses were merged", async () => {
    const report = await scanWallets(client({}), [EOA, SAFE], options);
    expect(report.notes[0]!.message).toContain(SAFE);
    expect(report.notes[0]!.message).toContain("must sign");
  });

  it("does not repeat the same note once per address", async () => {
    const report = await scanWallets(client({}), [EOA, SAFE], options);
    const scope = report.notes.filter((n) => n.message.includes("held directly by this address"));
    expect(scope).toHaveLength(1);
  });

  it("dedupes a repeated address instead of double-counting it", async () => {
    const report = await scanWallets(client({ [EOA.toLowerCase()]: [1n] }), [EOA, EOA], options);
    expect(report.items).toHaveLength(1);
  });

  it("warns about contract-held positions even when the wallet is empty", async () => {
    // The dangerous case: a bare "nothing found" on a wallet whose LP is in a Safe.
    const report = await scanWallets(client({}), [EOA], options);
    expect(report.items).toHaveLength(0);
    expect(report.notes.some((n) => n.message.includes("--also"))).toBe(true);
  });
});
