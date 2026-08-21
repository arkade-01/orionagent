#!/usr/bin/env node
import { getAddress, type Address } from "viem";
import { writeBrief } from "./agent/brief.js";
import { chainScanClanker } from "./chainscan.js";
import { createAgentWallet, createBaseClient, assertBaseChain } from "./chain.js";
import { executePermissionless, toOwnerSignRequests } from "./claims.js";
import { loadConfig } from "./config.js";
import { buildClaimPlan, scanWallet, type EngineOptions } from "./engine.js";
import { renderChainScan, renderClaimPlan, renderReport, toJson } from "./format.js";
import type { SourceId } from "./types.js";

interface Flags {
  json: boolean;
  brief: boolean;
  execute: boolean;
  includePending: boolean;
  sources?: SourceId[];
  tokens: Address[];
  minUsd?: number;
  lookback?: bigint;
  maxPairs?: number;
}

const USAGE = `orionscope — unclaimed on-chain value on Base (chainId 8453)

  scan <address>        Scan a wallet across Clanker, Merkl and Uniswap v3
  claim <address>       Scan, then build the claim txs
  chainscan             Rank Clanker creators sitting on unclaimed fees

Options
  --json                Machine-readable output (bigints as strings)
  --brief               Also write the narrated brief
  --execute             claim only: submit the permissionless txs from the agent
                        signer (needs AGENT_PRIVATE_KEY). owner-sign txs are
                        never submitted.
  --source <id>         Restrict to clanker | merkl | uniswap-v3 (repeatable)
  --token <address>     Extra Clanker token to check (repeatable)
  --include-pending     Probe pool-side Clanker fees (needs eth_simulateV1)
  --min-usd <n>         chainscan only: minimum USD to report
  --lookback <blocks>   chainscan only: how far back to look for fee accrual
                        (default 20000, ~11h on Base)
  --max-pairs <n>       chainscan only: cap on (recipient, token) pairs read
`;

function parseFlags(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {
    json: false,
    brief: false,
    execute: false,
    includePending: false,
    tokens: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json": flags.json = true; break;
      case "--brief": flags.brief = true; break;
      case "--execute": flags.execute = true; break;
      case "--include-pending": flags.includePending = true; break;
      case "--source": (flags.sources ??= []).push(argv[++i] as SourceId); break;
      case "--token": flags.tokens.push(getAddress(argv[++i]!)); break;
      case "--min-usd": flags.minUsd = Number(argv[++i]); break;
      case "--lookback": flags.lookback = BigInt(argv[++i]!); break;
      case "--max-pairs": flags.maxPairs = Number(argv[++i]); break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        positional.push(arg);
    }
  }
  return { positional, flags };
}

function engineOptions(flags: Flags, agentAddress?: Address): EngineOptions {
  return {
    sources: flags.sources,
    clanker: { tokens: flags.tokens, includePending: flags.includePending },
    agentAddress,
  };
}

async function main(): Promise<number> {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const [command, target] = positional;

  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return 0;
  }

  const { rpcUrl } = loadConfig();
  const client = createBaseClient(rpcUrl);
  await assertBaseChain(client);

  if (command === "chainscan") {
    const result = await chainScanClanker(client, {
      minUsd: flags.minUsd,
      lookbackBlocks: flags.lookback,
      maxPairs: flags.maxPairs,
    });
    console.log(flags.json ? toJson(result) : renderChainScan(result));
    return 0;
  }

  if (command !== "scan" && command !== "claim") {
    console.error(`Unknown command "${command}".\n\n${USAGE}`);
    return 1;
  }
  if (!target) {
    console.error(`${command} needs a wallet address.\n\n${USAGE}`);
    return 1;
  }

  const owner = getAddress(target);
  // Knowing the agent up front lets Merkl report the true claim type rather
  // than assuming, so resolve it even when we are not going to send anything.
  const agent = createAgentWallet(rpcUrl);
  const options = engineOptions(flags, agent?.account?.address);
  const report = await scanWallet(client, owner, options);

  if (command === "scan") {
    console.log(flags.json ? toJson(report) : renderReport(report));
    if (flags.brief) {
      const brief = await writeBrief(report);
      console.log(`\n--- brief (${brief.origin}) ---\n${brief.text}`);
      if (brief.violations.length > 0) {
        console.error(
          `\nLLM brief rejected — it contained figures not present in the scan: ` +
            `${brief.violations.join(", ")}. Showed the deterministic brief instead.`,
        );
      }
    }
    return 0;
  }

  // claim
  const { txs, errors } = await buildClaimPlan(client, report, options);
  console.log(flags.json ? toJson({ report, txs, errors }) : renderReport(report));
  if (!flags.json) console.log(`\n--- claim plan ---\n${renderClaimPlan(txs)}`);
  for (const err of errors) console.error(`Could not build ${err.source} claim: ${err.message}`);

  if (!flags.execute) {
    const ownerSign = toOwnerSignRequests(txs);
    if (ownerSign.length > 0 && !flags.json) {
      console.log(
        `\n${ownerSign.length} tx(s) need the owner's signature. ` +
          `Nothing was submitted — rerun with --execute to send the permissionless ones.`,
      );
    }
    return 0;
  }

  const wallet = agent;
  if (!wallet) {
    console.error("--execute needs AGENT_PRIVATE_KEY. owner-sign txs are never submitted anyway.");
    return 1;
  }

  const results = await executePermissionless(client, wallet, txs);
  for (const r of results) {
    console.log(`${r.status.padEnd(7)} ${r.hash ?? ""} ${r.reason ?? ""}  ${r.tx.description}`);
  }
  return results.some((r) => r.status === "failed") ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message);
    process.exit(1);
  },
);
