#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { assertBaseChain, createBaseClient } from "../chain.js";
import { loadConfig } from "../config.js";
import { agentCapabilities, type AnyCapability, type CapabilityContext } from "../registry.js";

const VERSION = "0.1.0";

/**
 * MCP surface for Orionscope.
 *
 * Everything comes from the shared capability registry, so the tools an agent
 * sees cannot drift from what the CLI does — the same handlers back both. The
 * registry also filters out `spend`, so no tool here can broadcast a
 * transaction: the worst case is a public read or some unsigned calldata.
 */
export function createOrionscopeServer(ctx: CapabilityContext): McpServer {
  const server = new McpServer({ name: "orionscope", version: VERSION });

  for (const capability of agentCapabilities()) {
    register(server, capability, ctx);
  }
  return server;
}

function register(server: McpServer, capability: AnyCapability, ctx: CapabilityContext): void {
  server.registerTool(
    capability.name,
    {
      title: capability.title,
      description: capability.description,
      inputSchema: capability.input,
      annotations: {
        // `build` still writes nothing: it returns calldata for a human to sign.
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const result = await capability.handler(args as never, ctx);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        // Surface the failure to the model rather than throwing: a source that
        // could not be read must never look like a wallet with nothing in it.
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text:
                `${capability.name} failed: ${(err as Error).message}\n\n` +
                `This is a failure to read, NOT a finding that the wallet is empty. ` +
                `Do not report it as "nothing found".`,
            },
          ],
        };
      }
    },
  );
}

async function main(): Promise<void> {
  const { rpcUrl } = loadConfig();
  const client = createBaseClient(rpcUrl);

  // Fail loudly at startup rather than returning empty scans from a dead RPC.
  await assertBaseChain(client, rpcUrl);

  const server = createOrionscopeServer({ client });
  await server.connect(new StdioServerTransport());
}

// stdio is the protocol channel — diagnostics must go to stderr, never stdout.
const invokedDirectly = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (invokedDirectly) {
  main().catch((err: Error) => {
    process.stderr.write(`orionscope mcp: ${err.message}\n`);
    process.exit(1);
  });
}
