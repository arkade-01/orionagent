import { getAddress, isAddress, type PublicClient } from "viem";
import { z } from "zod";
import { chainScanClanker } from "./chainscan.js";
import { buildClaimPlan, scanWallet, type EngineOptions } from "./engine.js";
import { jsonReplacer } from "./format.js";
import type { SourceId } from "./types.js";

/**
 * What a capability is allowed to do.
 *
 * - `read`  — on-chain reads and API calls only.
 * - `build` — produces UNSIGNED transactions. Nothing is broadcast.
 * - `spend` — broadcasts a transaction and costs real gas.
 *
 * This distinction is the non-custodial guarantee, expressed once. Front-ends do
 * not get to decide it: `agentCapabilities()` filters `spend` out, so an agent
 * surface cannot expose one even by accident. Spending stays a deliberate human
 * action through the CLI.
 */
export type RiskClass = "read" | "build" | "spend";

export interface CapabilityContext {
  client: PublicClient;
  /** Applied to every engine call so front-ends share one configuration. */
  engineOptions?: EngineOptions;
}

/** A capability with its input shape erased, for storage and dispatch. */
export type AnyCapability = Capability<z.ZodRawShape>;

export interface Capability<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  risk: RiskClass;
  /** Zod raw shape — consumed directly by MCP, and by the HTTP layer later. */
  input: Shape;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: CapabilityContext) => Promise<unknown>;
}

const address = z
  .string()
  .refine(isAddress, "must be a 0x-prefixed EVM address")
  .describe("Wallet address to inspect, on Base (chainId 8453)");

const deep = z
  .boolean()
  .optional()
  .describe(
    "Walk FeeLocker history for every currency this wallet has ever earned in. " +
      "The only complete Clanker answer, but it issues ~1900 requests and wants an RPC " +
      "with real throughput. Without it, currencies from deploys the wallet did not make " +
      "are invisible.",
  );

const sources = z
  .array(z.enum(["clanker", "merkl", "uniswap-v3"]))
  .optional()
  .describe("Restrict the scan to these sources. Defaults to all three.");

/** bigints are not JSON; every capability result goes through this. */
function serializable<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}

function engineOptions(ctx: CapabilityContext, args: { deep?: boolean; sources?: SourceId[] }): EngineOptions {
  return {
    ...ctx.engineOptions,
    ...(args.sources ? { sources: args.sources } : {}),
    clanker: { ...ctx.engineOptions?.clanker, ...(args.deep ? { deep: true } : {}) },
  };
}

const scanWalletCapability: Capability<{
  address: typeof address;
  deep: typeof deep;
  sources: typeof sources;
}> = {
  name: "scan_wallet",
  title: "Scan a wallet for unclaimed value",
  description:
    "Find unclaimed on-chain value for a Base wallet across Clanker creator fees, Merkl " +
    "incentives, and Uniswap v3 LP fees. Every amount returned is a real on-chain read or API " +
    "call recorded in that item's `provenance` — nothing is estimated. `usdValue` is null when " +
    "no reliable price exists; report those as unpriced rather than guessing or omitting them. " +
    "Read `notes` and `errors`: a source that failed contributes nothing, and 'nothing found' " +
    "from a failed read is not the same as 'nothing owed'. Never restate an amount in a form " +
    "the report does not contain — no rounding, no totals it does not give you.",
  risk: "read",
  input: { address, deep, sources },
  handler: async (args, ctx) =>
    serializable(await scanWallet(ctx.client, getAddress(args.address), engineOptions(ctx, args))),
};

const buildClaimPlanCapability: Capability<{
  address: typeof address;
  deep: typeof deep;
  sources: typeof sources;
}> = {
  name: "build_claim_plan",
  title: "Build the transactions that claim what a wallet is owed",
  description:
    "Scan a wallet and return the UNSIGNED transactions that would claim it. Nothing is " +
    "broadcast and no key is used — this returns calldata for the owner to sign. Transactions " +
    "marked `permissionless` route funds to the owner no matter who submits them; `owner-sign` " +
    "ones only the owner can send. A tx with `isPrerequisite` must land before the claim that " +
    "follows it. Merkl proofs are fetched fresh here and expire in roughly four hours, so a " +
    "plan is perishable — rebuild rather than reusing an old one.",
  risk: "build",
  input: { address, deep, sources },
  handler: async (args, ctx) => {
    const owner = getAddress(args.address);
    const options = engineOptions(ctx, args);
    const report = await scanWallet(ctx.client, owner, options);
    const { txs, errors } = await buildClaimPlan(ctx.client, report, options);
    return serializable({ owner, blockNumber: report.blockNumber, report, txs, errors });
  },
};

const chainScanCapability: Capability<{
  lookbackBlocks: z.ZodOptional<z.ZodNumber>;
  minUsd: z.ZodOptional<z.ZodNumber>;
  maxPairs: z.ZodOptional<z.ZodNumber>;
}> = {
  name: "chain_scan",
  title: "Rank Clanker creators sitting on unclaimed fees",
  description:
    "Find wallets across Base with unclaimed Clanker creator fees, ranked by USD value. Uses " +
    "the FeeLocker's own StoreTokens events as the universe, so every result is a wallet that " +
    "actually accrued fees. A lead marked `looksInactive` has accrued fees but no claim in the " +
    "lookback window. Unpriced leads may still be significant; absence of a price is not " +
    "absence of value.",
  risk: "read",
  input: {
    lookbackBlocks: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("How far back to look for fee accrual. Base is ~2s/block; default 20000."),
    minUsd: z.number().nonnegative().optional().describe("Minimum USD value to report."),
    maxPairs: z.number().int().positive().optional().describe("Cap on (recipient, token) pairs read."),
  },
  handler: async (args, ctx) =>
    serializable(
      await chainScanClanker(ctx.client, {
        ...(args.lookbackBlocks ? { lookbackBlocks: BigInt(args.lookbackBlocks) } : {}),
        ...(args.minUsd !== undefined ? { minUsd: args.minUsd } : {}),
        ...(args.maxPairs ? { maxPairs: args.maxPairs } : {}),
      }),
    ),
};

/**
 * Every capability the product has. Adding a `spend` capability here is safe —
 * `agentCapabilities()` will still refuse to expose it.
 */
export const CAPABILITIES: AnyCapability[] = [
  scanWalletCapability,
  buildClaimPlanCapability,
  chainScanCapability,
] as unknown as AnyCapability[];

/**
 * The capabilities an agent surface (MCP, HTTP) may expose.
 *
 * Executing a transaction is deliberately not reachable from any agent path.
 * There is no approval flow to get wrong and no signer behind the API, so the
 * worst a compromised or confused agent can do is read public data and hand back
 * calldata the owner still has to sign.
 */
export function agentCapabilities(): AnyCapability[] {
  return CAPABILITIES.filter((c) => c.risk !== "spend");
}

export function findCapability(name: string): AnyCapability | undefined {
  return agentCapabilities().find((c) => c.name === name);
}
