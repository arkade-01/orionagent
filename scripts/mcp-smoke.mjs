#!/usr/bin/env node
/**
 * Launches the MCP server as a real subprocess over stdio and drives it the way
 * a client does. The in-memory tests cover behaviour; this covers the things
 * only a real launch can break — the shebang, the stdio wiring, and whether
 * anything pollutes stdout and corrupts the protocol stream.
 *
 * Usage: node scripts/mcp-smoke.mjs [address]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const address = process.argv[2] ?? "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504";

// StdioClientTransport passes only a safe subset of env to the child, so
// BASE_RPC_URL has to be handed over explicitly. Real MCP clients behave the
// same way — which is why the server reads .env itself rather than trusting
// the launching shell's environment.
// `inherit`, not `pipe`: the server's startup diagnostics are the whole point
// when this fails. Piping them into a stream nobody reads turns a precise
// "your RPC is rate-limiting every request" into the client's opaque
// "Connection closed".
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "--env-file-if-exists=.env", "src/mcp/server.ts"],
  env: { ...process.env },
  stderr: "inherit",
});

const client = new Client({ name: "orionscope-smoke", version: "0" });

try {
  try {
    await client.connect(transport);
  } catch (err) {
    // "Connection closed" means the server exited during startup. Its reason
    // has already been printed above by the inherited stderr.
    console.error(
      `\nThe server exited before the handshake completed (${err.message}).\n` +
        `Its reason is printed above. The usual cause is BASE_RPC_URL in .env pointing at an\n` +
        `endpoint that is unreachable, throttled, or not Base.`,
    );
    process.exit(1);
  }
  console.log("connected to the server over stdio\n");

  const { tools } = await client.listTools();
  console.log(`tools advertised: ${tools.length}`);
  for (const t of tools) {
    console.log(`  ${t.name.padEnd(18)} readOnly=${t.annotations?.readOnlyHint} — ${t.title}`);
  }
  if (tools.some((t) => t.name === "execute_permissionless")) {
    throw new Error("a spend tool is exposed over MCP — the registry guard failed");
  }
  console.log("\nno spend tool exposed\n");

  console.log(`calling scan_wallet on ${address} (clanker only, fast) ...`);
  const result = await client.callTool({
    name: "scan_wallet",
    arguments: { address, sources: ["clanker"] },
  });

  if (result.isError) {
    console.log(`\ntool reported an error (this is the honest path, not a crash):`);
    console.log(result.content[0].text.split("\n").slice(0, 3).join("\n"));
  } else {
    const report = JSON.parse(result.content[0].text);
    console.log(`\nblock ${report.blockNumber}`);
    console.log(`items: ${report.totals.itemCount} (${report.totals.unpricedCount} unpriced)`);
    for (const item of report.items) {
      console.log(`  ${item.rawAmount} ${item.token.symbol ?? item.token.address}`);
      console.log(`    provenance: ${item.provenance.map((p) => p.call).join("; ")}`);
    }
    for (const n of report.notes) console.log(`  note: ${n.message.slice(0, 100)}`);
  }
} finally {
  await client.close().catch(() => {});
}
