import Anthropic from "@anthropic-ai/sdk";
import { formatAmount } from "../tokens.js";
import type { ScanReport, UnclaimedItem } from "../types.js";

const MODEL = "claude-opus-5";

/**
 * The facts handed to the model, plus every number it is allowed to write.
 *
 * Invariant #4: the LLM narrates structured data — it does not compute, round,
 * or restate a figure in a form we did not hand it. `allowedNumbers` is what
 * makes that checkable rather than aspirational: it is derived from the facts
 * text itself, so the rule enforced is exactly "every number in the brief
 * appears verbatim in the facts", and each fact traces to an
 * `UnclaimedItem.provenance` entry.
 */
export interface BriefFacts {
  lines: string[];
  allowedNumbers: Set<string>;
}

function usd(n: number): string {
  return n.toFixed(2);
}

function describeItem(item: UnclaimedItem): string {
  const amount = formatAmount(item.rawAmount, item.token);
  const symbol = item.token.symbol ?? item.token.address;
  const value = item.usdValue === null ? "unpriced" : `$${usd(item.usdValue)}`;
  return (
    `- [${item.source}] ${item.label} | amount: ${amount} ${symbol} ` +
    `| raw: ${item.rawAmount} | usd: ${value} | claim: ${item.claimType} ` +
    `| provenance: ${item.provenance.map((p) => `${p.kind}:${p.call}`).join("; ")}`
  );
}

/** The only thing the model ever sees. Nothing is summarized on the way in. */
export function buildFacts(report: ScanReport): BriefFacts {
  const lines: string[] = [
    `owner: ${report.owner}`,
    `chainId: ${report.chainId}`,
    `block: ${report.blockNumber}`,
    `generatedAt: ${report.generatedAt}`,
    `items: ${report.totals.itemCount}`,
    `priced items: ${report.totals.pricedCount}`,
    `unpriced items: ${report.totals.unpricedCount}`,
    `total USD across priced items only: $${usd(report.totals.pricedUsd)}`,
    "",
    "ITEMS:",
  ];

  for (const item of report.items) lines.push(describeItem(item));

  if (report.notes.length > 0) {
    lines.push("", "NOTES:");
    for (const note of report.notes) lines.push(`- [${note.source}] ${note.message}`);
  }
  if (report.errors.length > 0) {
    lines.push("", "SOURCES THAT FAILED TO READ (nothing is known about these):");
    for (const err of report.errors) lines.push(`- [${err.source}] ${err.message}`);
  }

  return { lines, allowedNumbers: new Set(numericTokens(lines.join("\n"))) };
}

const SYSTEM_PROMPT = `You write a short brief about unclaimed on-chain value for a wallet owner.

You are given a list of facts. Narrate them. That is the entire job.

Hard rules:
- Use ONLY numbers that appear verbatim in the facts. Copy them character for character.
- Never add, subtract, total, average, round, convert, or reformat any number. If a
  total is not in the facts, there is no total to state.
- Never write a number that is not in the facts — not even an approximation, a
  range, an item count you worked out yourself, or a percentage.
- Items marked "unpriced" have no reliable USD price. Say "unpriced". Do not guess
  a value, compare them to priced items, or imply they are small.
- A total labelled "priced items only" covers priced items only. Say so.
- If a source failed to read, say that source could not be read. Do not speculate
  about what it might contain.
- Group by how it gets claimed: "permissionless" items can be claimed for the owner
  automatically; "owner-sign" items need the owner's signature.

Plain prose, no preamble, no markdown headings, at most 200 words.`;

export interface BriefResult {
  text: string;
  /** "llm" when the model produced it and it passed verification. */
  origin: "llm" | "deterministic";
  /** Numbers the model emitted that were not in the facts. Empty on success. */
  violations: string[];
}

/**
 * Pull every number-shaped token out of text, normalized so "1,234.50" and
 * "1234.50" compare equal.
 *
 * Hex literals are stripped first: an address or tx hash is an identifier, not a
 * quantity, and letting its digit runs through would whitelist arbitrary numbers
 * on both sides of the comparison.
 */
export function numericTokens(text: string): string[] {
  const withoutHex = text.replace(/0x[0-9a-fA-F]+/g, " ");
  return (withoutHex.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));
}

/**
 * Reject any brief containing a figure we did not supply. Numbers are compared
 * after stripping thousands separators; trailing zeros are tolerated (1.50 vs
 * 1.5) since that is presentation, not a different quantity. Rounding is NOT
 * tolerated — "5.26" for 5.260525... is a different number and fails.
 */
export function verifyBrief(text: string, allowed: Set<string>): string[] {
  const normalized = new Set<string>();
  for (const a of allowed) {
    normalized.add(a);
    if (a.includes(".")) normalized.add(a.replace(/0+$/, "").replace(/\.$/, ""));
  }
  return numericTokens(text).filter((n) => {
    if (normalized.has(n)) return false;
    const trimmed = n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n;
    return !normalized.has(trimmed);
  });
}

/** No API key, or a brief that failed verification: fall back to this. */
export function deterministicBrief(report: ScanReport): string {
  if (report.items.length === 0) {
    const tail = report.errors.length
      ? ` ${report.errors.length} source(s) could not be read: ${report.errors.map((e) => e.source).join(", ")}.`
      : "";
    return `No unclaimed value found for ${report.owner} at block ${report.blockNumber}.${tail}`;
  }

  const auto = report.items.filter((i) => i.claimType === "permissionless");
  const sign = report.items.filter((i) => i.claimType === "owner-sign");
  const line = (i: UnclaimedItem) =>
    `  - ${i.label}: ${formatAmount(i.rawAmount, i.token)} ${i.token.symbol ?? i.token.address}` +
    (i.usdValue === null ? " (unpriced)" : ` ($${usd(i.usdValue)})`);

  const parts = [
    `${report.owner} has ${report.totals.itemCount} unclaimed position(s) at block ${report.blockNumber}.`,
    `${report.totals.pricedCount} priced, totalling $${usd(report.totals.pricedUsd)} across priced items only; ` +
      `${report.totals.unpricedCount} unpriced.`,
  ];
  if (auto.length > 0) parts.push("", "Auto-claimable now:", ...auto.map(line));
  if (sign.length > 0) parts.push("", "One-click, needs your signature:", ...sign.map(line));
  for (const note of report.notes) parts.push("", `Note (${note.source}): ${note.message}`);
  for (const err of report.errors) parts.push("", `Could not read ${err.source}: ${err.message}`);
  return parts.join("\n");
}

/**
 * LLM brief with a hard numeric gate.
 *
 * The model only ever narrates; every figure in its output must appear verbatim
 * in the facts it was given, and each of those facts traces to an
 * `UnclaimedItem.provenance` entry. If it emits anything else we throw the brief
 * away and ship the deterministic one — a wrong number is worse than a dull
 * sentence, because the whole product is that the numbers are real.
 */
export async function writeBrief(
  report: ScanReport,
  opts: { client?: Anthropic; apiKey?: string } = {},
): Promise<BriefResult> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!opts.client && !apiKey) {
    return { text: deterministicBrief(report), origin: "deterministic", violations: [] };
  }

  const client = opts.client ?? new Anthropic({ apiKey });
  const facts = buildFacts(report);

  let text: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: `FACTS\n${facts.lines.join("\n")}` }],
    });
    if (response.stop_reason === "refusal") {
      return { text: deterministicBrief(report), origin: "deterministic", violations: [] };
    }
    text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch {
    return { text: deterministicBrief(report), origin: "deterministic", violations: [] };
  }

  const violations = verifyBrief(text, facts.allowedNumbers);
  if (violations.length > 0) {
    return { text: deterministicBrief(report), origin: "deterministic", violations };
  }
  return { text, origin: "llm", violations: [] };
}
