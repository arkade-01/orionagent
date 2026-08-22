import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * The in-memory tests exercise behaviour; these exercise the launch.
 *
 * stdio MCP uses stdout as the protocol channel, so a stray `console.log`
 * anywhere in the import graph — ours or a dependency's — corrupts the stream
 * and the client fails with an opaque parse error. That cannot be caught
 * in-process, because in-process tests never touch the real stdout.
 *
 * Deliberately pointed at an unreachable RPC: startup must fail, and the point
 * is that it fails *on stderr* with stdout untouched.
 */
function launch(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/mcp/server.ts"], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));

    const done = (code: number | null) => resolve({ stdout, stderr, code });
    child.on("close", done);
    setTimeout(() => {
      child.kill();
      done(null);
    }, 45_000);
  });
}

describe("mcp server process", () => {
  it("writes diagnostics to stderr and never to stdout", async () => {
    const { stdout, stderr } = await launch({
      BASE_RPC_URL: "https://127.0.0.1:9/unreachable",
    });

    // stdout is the JSON-RPC channel. Any byte here that is not a protocol
    // message breaks every client that connects.
    expect(stdout).toBe("");
    expect(stderr).toContain("orionscope mcp:");
  }, 60_000);

  it("names the reason it could not start", async () => {
    const { stderr } = await launch({ BASE_RPC_URL: "https://127.0.0.1:9/unreachable" });
    expect(stderr).toMatch(/could not reach|rate-limiting|rejected the credentials/i);
  }, 60_000);

  it("refuses to start without BASE_RPC_URL rather than scanning nothing", async () => {
    const { stdout, stderr } = await launch({ BASE_RPC_URL: "" });
    expect(stdout).toBe("");
    expect(stderr).toContain("BASE_RPC_URL");
  }, 60_000);
});
