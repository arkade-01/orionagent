import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { summarizeError } from "../errors.js";
import { agentCapabilities, type AnyCapability, type CapabilityContext } from "../registry.js";

export interface ServerOptions {
  ctx: CapabilityContext;
  /**
   * Allow `deep: true` from HTTP callers.
   *
   * A deep scan issues ~1900 RPC requests. On a public deployment that is an
   * unauthenticated way to burn the operator's RPC budget, so it is off unless
   * the operator opts in. Locally it is harmless and on by default.
   */
  allowDeep?: boolean;
  /** Origins allowed to call the API. Defaults to same-origin only. */
  corsOrigins?: string[];
}

/**
 * HTTP surface for Orionscope.
 *
 * Routes are generated from the shared capability registry, so this layer holds
 * no product logic and cannot drift from the CLI or MCP. `agentCapabilities()`
 * filters out `spend`, which means there is no endpoint that broadcasts a
 * transaction and no signer behind the API at all.
 *
 * That is what makes the web UI non-custodial: the server returns unsigned
 * calldata, and the user's own wallet signs it in their browser. A compromised
 * server can lie about what you are owed; it cannot move anything.
 */
export function createApp(options: ServerOptions): Hono {
  const app = new Hono();
  const allowDeep = options.allowDeep ?? true;

  if (options.corsOrigins?.length) {
    app.use("/api/*", cors({ origin: options.corsOrigins }));
  }

  app.get("/api/health", (c) => c.json({ ok: true, chainId: 8453 }));

  app.get("/api/capabilities", (c) =>
    c.json({
      capabilities: agentCapabilities().map((cap) => ({
        name: cap.name,
        title: cap.title,
        description: cap.description,
        risk: cap.risk,
      })),
      // Stated so a client knows why a deep scan was refused rather than guessing.
      allowDeep,
    }),
  );

  for (const capability of agentCapabilities()) {
    app.post(`/api/${capability.name}`, async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }

      const parsed = z.object(capability.input).safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "invalid request", issues: z.treeifyError(parsed.error) },
          400,
        );
      }

      const args = parsed.data as Record<string, unknown>;
      if (args.deep === true && !allowDeep) {
        return c.json(
          {
            error: "deep scans are disabled on this server",
            detail:
              "A deep scan issues ~1900 RPC requests. The operator has not enabled it for HTTP " +
              "callers. Results from this endpoint cover the baseline currencies only and may be " +
              "incomplete.",
          },
          403,
        );
      }

      try {
        return c.json(await capability.handler(args as never, options.ctx));
      } catch (err) {
        // A failed read must never reach the client as an empty result — the UI
        // would render "nothing found" for a wallet that may hold plenty.
        return c.json(
          {
            error: summarizeError(err),
            detail:
              `${capability.name} could not complete. This is a failure to read, not a finding ` +
              `that the wallet is empty.`,
          },
          502,
        );
      }
    });
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

/** Exposed for tests and docs: the routes this server serves. */
export function routes(): { method: string; path: string; risk: AnyCapability["risk"] }[] {
  return [
    { method: "GET", path: "/api/health", risk: "read" },
    { method: "GET", path: "/api/capabilities", risk: "read" },
    ...agentCapabilities().map((c) => ({
      method: "POST",
      path: `/api/${c.name}`,
      risk: c.risk,
    })),
  ];
}
