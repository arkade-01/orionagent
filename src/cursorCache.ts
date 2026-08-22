import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getAddress, type Address } from "viem";

/**
 * Remembers how far a deep scan got for each owner, so a second scan walks only
 * the new tail instead of 400+ days of history again.
 *
 * The cursor is the discovery watermark — the highest block with an unbroken run
 * of successful windows behind it. A resumed scan never looks below its cursor,
 * so advancing past a failed window would hide that gap forever. Partial scans
 * therefore advance the cursor only as far as they are actually sound.
 */
export interface OwnerCursor {
  /** Everything below this block has been fully scanned. */
  cursor: string;
  /** Currencies found so far. Only ever grows. */
  currencies: string[];
  updatedAt: string;
}

interface CacheFile {
  version: 1;
  owners: Record<string, OwnerCursor>;
}

/**
 * A factory, not a shared constant: `{ ...EMPTY }` copies the `owners`
 * reference, so every "empty" cache would mutate one shared object and leak
 * entries between different cache files.
 */
function emptyCache(): CacheFile {
  return { version: 1, owners: {} };
}

export function cachePath(): string {
  const override = process.env.ORIONSCOPE_CACHE_DIR?.trim();
  return join(override || join(homedir(), ".orionscope"), "clanker-currencies.json");
}

function read(path: string): CacheFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    // A cache is an optimisation, never a source of truth. Anything unexpected
    // is discarded rather than reconciled — a full rescan is always correct.
    if (parsed?.version !== 1 || typeof parsed.owners !== "object" || parsed.owners === null) {
      return emptyCache();
    }
    return parsed;
  } catch {
    return emptyCache();
  }
}

export function loadCursor(owner: Address, path = cachePath()): OwnerCursor | null {
  return read(path).owners[getAddress(owner).toLowerCase()] ?? null;
}

/**
 * Merge a discovery into the cache. Currencies union with what is already known,
 * and the cursor only ever moves forward.
 */
export function saveCursor(
  owner: Address,
  update: { watermark: bigint; currencies: Address[] },
  path = cachePath(),
): void {
  try {
    const file = read(path);
    const key = getAddress(owner).toLowerCase();
    const existing = file.owners[key];
    const previous = existing ? BigInt(existing.cursor) : 0n;

    file.owners[key] = {
      cursor: (update.watermark > previous ? update.watermark : previous).toString(),
      currencies: [
        ...new Set([...(existing?.currencies ?? []), ...update.currencies.map((c) => c.toLowerCase())]),
      ],
      updatedAt: new Date().toISOString(),
    };

    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2));
  } catch {
    // An unwritable cache must not fail a scan that already produced real reads.
  }
}
