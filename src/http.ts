/**
 * Retrying fetch for the external APIs.
 *
 * The RPC transport has retried since early on, but the plain HTTP calls to
 * Merkl, clanker.world and the price feed did not — so a single transient
 * "fetch failed" took out an entire source, and the report said that source
 * could not be read. Observed live: two consecutive scans of the same wallet,
 * a different API failing each time.
 *
 * Retries cover transport errors and 5xx/429. A 4xx is the server telling us
 * something definite, so it comes back immediately.
 */
export interface RetryOptions {
  attempts?: number;
  /** Base delay; doubles each attempt. */
  delayMs?: number;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. Without one a hung socket stalls the whole scan. */
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: RetryOptions = {},
): Promise<Response> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelay = options.delayMs ?? 250;
  const impl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
    }
    try {
      const res = await impl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}`);
      // Drain the body so the socket can be reused on the next attempt.
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Wraps a `fetch` so callers that take a `fetchImpl` get retries transparently.
 * A caller-supplied implementation (tests, stubs) is still respected.
 */
export function retryingFetch(fetchImpl?: typeof fetch, options: RetryOptions = {}): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    fetchWithRetry(String(url), init ?? {}, { ...options, ...(fetchImpl ? { fetchImpl } : {}) })) as typeof fetch;
}
