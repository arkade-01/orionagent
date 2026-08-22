import { formatAmount } from "./tokens.js";
import type { ChainScanResult } from "./chainscan.js";
import type { ClaimTx, ScanReport } from "./types.js";

/** JSON.stringify replacer that survives bigints. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer, 2);
}

function usd(value: number | null): string {
  return value === null ? "unpriced" : `$${value.toFixed(2)}`;
}

export function renderReport(report: ScanReport): string {
  const out: string[] = [
    `Orionscope — ${report.owner}`,
    `Base (chainId ${report.chainId}) @ block ${report.blockNumber} · ${report.generatedAt}`,
    "",
  ];

  if (report.items.length === 0) {
    // Saying "nothing found" while holding a list of real balances the owner
    // cannot reach from here would be the same lie as reporting $0 on a wallet
    // whose fees sit in a contract.
    out.push(
      report.unreachable.length > 0
        ? "Nothing claimable from the address(es) you scanned — but see below."
        : "No unclaimed value found.",
    );
  } else {
    const groups: [string, ScanReport["items"]][] = [
      ["Auto-claimable now", report.items.filter((i) => i.claimType === "permissionless")],
      ["One-click, needs your signature", report.items.filter((i) => i.claimType === "owner-sign")],
    ];
    for (const [title, items] of groups) {
      if (items.length === 0) continue;
      out.push(`${title}:`);
      for (const item of items) {
        out.push(
          `  ${usd(item.usdValue).padStart(12)}  ` +
            `${formatAmount(item.rawAmount, item.token)} ${item.token.symbol ?? item.token.address}`,
        );
        out.push(`  ${" ".repeat(12)}  ${item.label}`);
        for (const p of item.provenance) {
          out.push(`  ${" ".repeat(12)}    via ${p.kind} ${p.target} ${p.call}`);
        }
      }
      out.push("");
    }
    out.push(
      `Total (priced items only): $${report.totals.pricedUsd.toFixed(2)} ` +
        `across ${report.totals.pricedCount} item(s); ${report.totals.unpricedCount} unpriced.`,
    );
  }

  if (report.unreachable.length > 0) {
    out.push("", "Found, but NOT claimable from the address(es) you scanned:");
    for (const u of report.unreachable) {
      for (const a of u.amounts) {
        out.push(
          `  ${usd(a.usdValue).padStart(12)}  ${formatAmount(a.rawAmount, a.token)} ` +
            `${a.token.symbol ?? a.token.address}`,
        );
      }
      out.push(`  ${" ".repeat(12)}  held by ${u.holder}`);
      out.push(
        `  ${" ".repeat(12)}  ${
          u.looksControlledByOwner
            ? `reports you as its owner — collect through that contract`
            : `owner unknown — these may not be yours`
        }`,
      );
    }
    out.push(
      "",
      "  (excluded from the total above: this tool cannot build a transaction the holder would accept)",
    );
  }

  for (const note of report.notes) out.push("", `Note (${note.source}): ${note.message}`);
  for (const err of report.errors) out.push("", `Could not read ${err.source}: ${err.message}`);
  return out.join("\n");
}

export function renderClaimPlan(txs: ClaimTx[]): string {
  if (txs.length === 0) return "No claim transactions to build.";
  return txs
    .map((tx, i) => {
      const tag = tx.isPrerequisite ? " [prerequisite]" : "";
      return [
        `${i + 1}. ${tx.description}${tag}`,
        `   type: ${tx.claimType}`,
        `   to:   ${tx.to}`,
        `   data: ${tx.data}`,
        `   value: ${tx.value}`,
      ].join("\n");
    })
    .join("\n\n");
}

export function renderChainScan(result: ChainScanResult): string {
  const out = [
    `Clanker chain-scan @ block ${result.blockNumber} ` +
      `— ${result.scannedPairs} (recipient, token) pair(s) with accrual since block ${result.fromBlock}`,
    "",
  ];
  if (result.leads.length === 0) {
    out.push("No unclaimed creator-fee balances found in this slice.");
  } else {
    for (const lead of result.leads) {
      out.push(
        `${usd(lead.usdValue).padStart(12)}  ${formatAmount(lead.rawAmount, lead.token)} ` +
          `${lead.token.symbol ?? lead.token.address}`,
      );
      out.push(
        `${" ".repeat(14)}recipient ${lead.recipient}` +
          (lead.looksInactive
            ? "  (no claim in lookback window — lead)"
            : `  (last claim at block ${lead.lastClaimBlock})`),
      );
    }
  }
  for (const note of result.notes) out.push("", `Note: ${note}`);
  return out.join("\n");
}
