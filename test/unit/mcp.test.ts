import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createOrionscopeServer } from "../../src/mcp/server.js";

/** A client wired to the real server over an in-memory transport. */
async function connect(client: unknown) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOrionscopeServer({ client: client as never });
  await server.connect(serverTransport);

  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientTransport);
  return mcp;
}

describe("mcp server", () => {
  let mcp: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    mcp = await connect({
      getBlockNumber: async () => 50_000_000n,
      multicall: async () => [],
      readContract: async () => 0n,
      getLogs: async () => [],
      getContractEvents: async () => [],
    });
  });

  it("advertises exactly the agent-safe tools", async () => {
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "build_claim_plan",
      "chain_scan",
      "scan_wallet",
    ]);
  });

  it("advertises no tool that can broadcast a transaction", async () => {
    const { tools } = await mcp.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    expect(tools.map((t) => t.name)).not.toContain("execute_permissionless");
  });

  it("publishes the address schema so a client can validate before calling", async () => {
    const { tools } = await mcp.listTools();
    const scan = tools.find((t) => t.name === "scan_wallet")!;
    expect(scan.inputSchema.required).toContain("address");
    expect(Object.keys(scan.inputSchema.properties ?? {}).sort()).toEqual([
      "address",
      "deep",
      "sources",
    ]);
  });

  it("runs a scan and returns a JSON report", async () => {
    const result = await mcp.callTool({
      name: "scan_wallet",
      arguments: { address: "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504", sources: ["uniswap-v3"] },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0]!.text;
    const report = JSON.parse(text);
    expect(report.chainId).toBe(8453);
    expect(report.owner).toBe("0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504");
  });

  it("rejects a malformed address instead of scanning garbage", async () => {
    const result = await mcp.callTool({
      name: "scan_wallet",
      arguments: { address: "definitely-not-an-address" },
    });
    expect(result.isError).toBe(true);
  });

  it("tells the model a read failure is not an empty wallet", async () => {
    const broken = await connect({
      getBlockNumber: async () => {
        throw new Error("over rate limit");
      },
    });
    const result = await broken.callTool({
      name: "scan_wallet",
      arguments: { address: "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504" },
    });
    expect(result.isError).toBe(true);
    // The phrasing matters: a model summarising this must not say "nothing found".
    expect((result.content as { text: string }[])[0]!.text).toMatch(/not.*nothing found/is);
  });
});
