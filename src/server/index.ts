#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { assertBaseChain, createBaseClient } from "../chain.js";
import { loadConfig } from "../config.js";
import { createApp } from "./app.js";
import { routes } from "./app.js";

const DEFAULT_PORT = 8787;

async function main(): Promise<void> {
  const { rpcUrl } = loadConfig();
  const client = createBaseClient(rpcUrl);

  // Fail at boot rather than serving 502s from a dead RPC.
  await assertBaseChain(client, rpcUrl);

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  // Deep scans are ~1900 RPC requests each. Local development is fine; a public
  // deployment should opt in deliberately.
  const allowDeep = process.env.ORIONSCOPE_ALLOW_DEEP !== "false";
  const corsOrigins = process.env.ORIONSCOPE_CORS_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  const app = createApp({
    ctx: { client },
    allowDeep,
    ...(corsOrigins?.length ? { corsOrigins } : {}),
  });

  serve({ fetch: app.fetch, port }, (info) => {
    process.stdout.write(`orionscope api on http://localhost:${info.port}\n`);
    for (const r of routes()) {
      process.stdout.write(`  ${r.method.padEnd(4)} ${r.path.padEnd(28)} [${r.risk}]\n`);
    }
    process.stdout.write(
      `\nNo endpoint can broadcast a transaction; there is no signer behind this API.\n` +
        `Deep scans ${allowDeep ? "enabled" : "disabled (ORIONSCOPE_ALLOW_DEEP=false)"}.\n`,
    );
  });
}

const invokedDirectly =
  process.argv[1]?.endsWith("server/index.ts") || process.argv[1]?.endsWith("server/index.js");
if (invokedDirectly) {
  main().catch((err: Error) => {
    process.stderr.write(`orionscope api: ${err.message}\n`);
    process.exit(1);
  });
}
