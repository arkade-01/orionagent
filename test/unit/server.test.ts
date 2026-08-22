import { describe, expect, it } from "vitest";
import { createApp, routes } from "../../src/server/app.js";

const OWNER = "0x605Ee83d2F050cF4dA6035d8f6185CE5A3934504";

/** A public client that answers everything with "nothing here". */
const emptyClient = {
  getBlockNumber: async () => 50_000_000n,
  multicall: async () => [],
  readContract: async () => 0n,
  getLogs: async () => [],
  getContractEvents: async () => [],
} as never;

function app(opts: { allowDeep?: boolean; client?: unknown } = {}) {
  return createApp({
    ctx: {
      client: (opts.client ?? emptyClient) as never,
      engineOptions: { sources: ["uniswap-v3"], fetchImpl: (async () => {
        throw new Error("no network in tests");
      }) as never },
    },
    ...(opts.allowDeep === undefined ? {} : { allowDeep: opts.allowDeep }),
  });
}

async function post(a: ReturnType<typeof app>, path: string, body: unknown) {
  return a.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("http api", () => {
  it("serves a route per agent-safe capability and nothing else", () => {
    expect(routes().map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /api/health",
      "GET /api/capabilities",
      "POST /api/scan_wallet",
      "POST /api/build_claim_plan",
      "POST /api/chain_scan",
    ]);
  });

  it("has no endpoint that broadcasts a transaction", async () => {
    const res = await post(app(), "/api/execute_permissionless", { address: OWNER });
    expect(res.status).toBe(404);
  });

  it("advertises its capabilities", async () => {
    const res = await app().request("/api/capabilities");
    const body = (await res.json()) as { capabilities: { name: string; risk: string }[] };
    expect(body.capabilities.map((c) => c.name)).toContain("build_claim_plan");
    expect(body.capabilities.every((c) => c.risk !== "spend")).toBe(true);
  });

  it("runs a scan", async () => {
    const res = await post(app(), "/api/scan_wallet", { address: OWNER, sources: ["uniswap-v3"] });
    expect(res.status).toBe(200);
    const report = (await res.json()) as { owner: string; chainId: number; blockNumber: string };
    expect(report.owner).toBe(OWNER);
    expect(report.chainId).toBe(8453);
    // bigints survive as strings rather than blowing up serialization.
    expect(report.blockNumber).toBe("50000000");
  });

  it("rejects a malformed address with 400 and says what was wrong", async () => {
    const res = await post(app(), "/api/scan_wallet", { address: "nope" });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/address/i);
  });

  it("treats a missing body as invalid input, not as an empty scan", async () => {
    const res = await app().request("/api/scan_wallet", { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("refuses a deep scan when the operator has not enabled it", async () => {
    // ~1900 RPC requests per call is an unauthenticated way to burn the
    // operator's budget, so it must be opt-in on a public deployment.
    const res = await post(app({ allowDeep: false }), "/api/scan_wallet", {
      address: OWNER,
      deep: true,
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toMatch(/may be incomplete/i);
  });

  it("allows a deep scan when enabled", async () => {
    const res = await post(app({ allowDeep: true }), "/api/scan_wallet", {
      address: OWNER,
      deep: true,
      sources: ["uniswap-v3"],
    });
    expect(res.status).toBe(200);
  });

  it("returns 502 with 'not empty' framing when a read fails", async () => {
    const broken = {
      getBlockNumber: async () => {
        throw new Error("over rate limit");
      },
    };
    const res = await post(app({ client: broken }), "/api/scan_wallet", { address: OWNER });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toContain("rate limit");
    // The UI must not render this as "you are owed nothing".
    expect(body.detail).toMatch(/not a finding that the wallet is empty/i);
  });

  it("404s an unknown route", async () => {
    expect((await app().request("/api/nope")).status).toBe(404);
  });
});
