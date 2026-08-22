import { afterEach, describe, expect, it, vi } from "vitest";
import { assertBaseChain } from "../../src/chain.js";

const URL_ = "https://base-mainnet.example.com/v2/key";
const client = {} as never;

function stubFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ status, json: async () => body }));
}

afterEach(() => vi.unstubAllGlobals());

describe("assertBaseChain", () => {
  it("passes on Base", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { result: "0x2105" })); // 8453
    await expect(assertBaseChain(client, URL_)).resolves.toBeUndefined();
  });

  it("rejects a non-Base chain by name", async () => {
    vi.stubGlobal("fetch", stubFetch(200, { result: "0x1" }));
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(/chainId 1/);
  });

  it("says 'rate-limited' on a 429 instead of leaking a viem TypeError", async () => {
    // The bug this guards: viem's batching answered a provider-wide 429 with
    // "Cannot read properties of undefined (reading 'error')", so a throttled
    // key looked like an internal crash rather than a throttled key.
    vi.stubGlobal(
      "fetch",
      stubFetch(429, {
        error: { message: "Your app has been rate-limited due to high global traffic" },
      }),
    );
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(/rate-limiting every request/);
  });

  it("names the host so the reader knows which endpoint failed", async () => {
    vi.stubGlobal("fetch", stubFetch(429, { error: { message: "rate limit" } }));
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(/base-mainnet\.example\.com/);
  });

  it("distinguishes a bad key from a rate limit", async () => {
    vi.stubGlobal("fetch", stubFetch(401, { error: { message: "Unauthorized" } }));
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(/rejected the credentials/);
  });

  it("reports an unreachable host as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("fetch failed");
      }),
    );
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(/Could not reach/);
  });

  it("never puts the RPC URL's credentials in the message", async () => {
    vi.stubGlobal("fetch", stubFetch(429, { error: { message: "rate limit" } }));
    // Only the host is quoted. The API key lives in the URL path, and an error
    // message is the easiest place for it to end up in a log or a bug report.
    await expect(assertBaseChain(client, URL_)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("/v2/key") }),
    );
  });
});
