import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../../src/http.js";

function response(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

describe("fetchWithRetry", () => {
  it("survives a transient failure", async () => {
    // The bug this fixes: one "fetch failed" took out a whole source, and the
    // report told the user that source could not be read.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      if (++calls === 1) throw new Error("fetch failed");
      return response(200);
    });
    const res = await fetchWithRetry("https://api.example.com", {}, { fetchImpl, delayMs: 1 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("retries a 429 and a 503", async () => {
    for (const status of [429, 503]) {
      let calls = 0;
      const fetchImpl = vi.fn(async () => (++calls === 1 ? response(status) : response(200)));
      const res = await fetchWithRetry("https://api.example.com", {}, { fetchImpl, delayMs: 1 });
      expect(res.status).toBe(200);
      expect(calls).toBe(2);
    }
  });

  it("does not retry a 404 — that is a definite answer", async () => {
    const fetchImpl = vi.fn(async () => response(404));
    const res = await fetchWithRetry("https://api.example.com", {}, { fetchImpl, delayMs: 1 });
    expect(res.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts and throws the last error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    await expect(
      fetchWithRetry("https://api.example.com", {}, { fetchImpl, delayMs: 1, attempts: 3 }),
    ).rejects.toThrow("fetch failed");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("passes the request init through", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200),
    );
    await fetchWithRetry(
      "https://api.example.com",
      { headers: { accept: "application/json" } },
      { fetchImpl, delayMs: 1 },
    );
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      headers: { accept: "application/json" },
    });
  });

  it("applies a per-attempt timeout so a hung socket cannot stall a scan", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      response(200),
    );
    await fetchWithRetry("https://api.example.com", {}, { fetchImpl, delayMs: 1 });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
