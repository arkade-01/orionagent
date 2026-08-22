import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  CAPABILITIES,
  agentCapabilities,
  findCapability,
  type AnyCapability,
} from "../../src/registry.js";

describe("capability registry", () => {
  it("exposes the three v1 capabilities", () => {
    expect(agentCapabilities().map((c) => c.name).sort()).toEqual([
      "build_claim_plan",
      "chain_scan",
      "scan_wallet",
    ]);
  });

  it("classifies claim planning as build, not spend — it returns unsigned calldata", () => {
    expect(findCapability("build_claim_plan")?.risk).toBe("build");
  });

  it("ships no spend capability at all", () => {
    expect(CAPABILITIES.filter((c) => c.risk === "spend")).toEqual([]);
  });

  it("refuses to expose a spend capability even if one is added", () => {
    // The guard that makes the non-custodial claim structural rather than a
    // convention: a future capability that broadcasts must not become reachable
    // from an agent surface just by being registered.
    const dangerous: AnyCapability = {
      name: "execute_permissionless",
      title: "Broadcast the claim transactions",
      description: "spends gas",
      risk: "spend",
      input: {},
      handler: async () => ({ sent: true }),
    };
    CAPABILITIES.push(dangerous);
    try {
      expect(agentCapabilities().map((c) => c.name)).not.toContain("execute_permissionless");
      expect(findCapability("execute_permissionless")).toBeUndefined();
    } finally {
      CAPABILITIES.pop();
    }
  });

  it("every capability documents itself for a model that has no other context", () => {
    for (const c of agentCapabilities()) {
      expect(c.title.length).toBeGreaterThan(0);
      // Long enough to carry the caveats a model needs: unpriced handling,
      // failed sources, proof expiry.
      expect(c.description.length).toBeGreaterThan(120);
    }
  });

  it("tells the model that unpriced is not zero and a failed read is not empty", () => {
    const scan = findCapability("scan_wallet")!.description;
    expect(scan).toMatch(/unpriced/i);
    expect(scan).toMatch(/not the same as/i);
  });

  it("warns that a claim plan goes stale", () => {
    expect(findCapability("build_claim_plan")!.description).toMatch(/four hours|expire/i);
  });

  it("validates the address argument", () => {
    const shape = findCapability("scan_wallet")!.input;
    const schema = z.object(shape);
    expect(schema.safeParse({ address: "not-an-address" }).success).toBe(false);
    expect(
      schema.safeParse({ address: "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" }).success,
    ).toBe(true);
  });

  it("returns JSON-safe output — bigints would otherwise throw on serialize", async () => {
    const client = {
      getBlockNumber: async () => 50_000_000n,
      multicall: async () => [],
      readContract: async () => 0n,
      getLogs: async () => [],
      getContractEvents: async () => [],
    };
    const result = await findCapability("scan_wallet")!.handler(
      { address: "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" } as never,
      { client: client as never, engineOptions: { sources: ["uniswap-v3"], fetchImpl: vi.fn() as never } },
    );
    // The real assertion: this does not throw "Do not know how to serialize a BigInt".
    expect(() => JSON.stringify(result)).not.toThrow();
    expect((result as { blockNumber: string }).blockNumber).toBe("50000000");
  });
});
