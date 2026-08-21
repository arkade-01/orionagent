import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

/**
 * Vitest does not put .env into process.env, and the fork suites need
 * BASE_RPC_URL to decide whether to run or skip. Load it here so `pnpm test`
 * behaves the same as `pnpm dev`. A real environment variable always wins.
 */
function dotenv(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".env", "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^["']|["']$/g, "")];
        })
        .filter(([key, value]) => key && value),
    );
  } catch {
    return {};
  }
}

export default defineConfig({
  test: {
    env: dotenv(),
    // Fork suites each boot their own Anvil on a shared port, and they mutate
    // shared chain state — run files one at a time.
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 240_000,
  },
});
