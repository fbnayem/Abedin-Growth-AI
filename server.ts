// P0.2 — MUST BE THE FIRST IMPORT. This module calls dotenv.config() at evaluation time.
// ES module imports are hoisted and evaluated in source order before this file's own
// statements run, so the `dotenv.config()` call further down was too late for any module
// that read process.env while being imported — notably the ActionGateway's Safe Mode flags.
// Keeping this first guarantees .env is loaded before any other module body executes.
//
// S39 — a side-effect import, since the readiness route that used its exports moved to a router.
// The move pruned the named import and with it the ordering: the first import became the rate
// limiter, `server/config/environment.ts` evaluated with no DATABASE_URL, the store came up as
// null, and every tenant-scoped request answered TENANT_REVOCATION_UNVERIFIABLE — found by the
// live probe, not by the gate, which is why decomposition.invariant now pins this line.
import './server/config/safeMode';
import { standardApiLimiter, aiOperationLimiter, webhookLimiter } from './server/middleware/rateLimit';
import { requireAuth } from "./server/middleware/auth";
import { securityHeaders } from "./server/middleware/securityHeaders";
import { resolveTenant } from "./server/middleware/tenant";
import { requestId, terminalErrorHandler } from "./server/lib/errors";
import { outboxWorker } from "./server/workers/outbox.worker";
import { campaignScheduler } from "./server/workers/campaignScheduler";
import { stripeRouter } from "./server/routes/stripe.routes";
import { outboxRouter } from "./server/routes/outbox.routes";
import { autonomyRouter } from "./server/routes/autonomy.routes";
import { unsubscribeRouter } from "./server/routes/unsubscribe.routes";
import { isUnauthenticatedApiPath } from "./server/middleware/authAllowlist";
import { cspReportRouter } from "./server/routes/cspReport.routes";
import { CSP_REPORT_PATH } from "./server/middleware/securityHeaders";
import { resolvePort } from "./server/config/port";
import { actionTrailRouter } from "./server/routes/actionTrail.routes";
import { spendRouter } from "./server/routes/spend.routes";
import { openapiRouter } from "./server/routes/openapi.routes";
import { deliverabilityRouter } from "./server/routes/deliverability.routes";
import { healthRouter } from "./server/routes/health.routes";
import { contactsRouter } from "./server/routes/contacts.routes";
import { inboxRouter } from "./server/routes/inbox.routes";
import { knowledgeRouter } from "./server/routes/knowledge.routes";
import { reportingRouter } from "./server/routes/reporting.routes";
import { pipelineRouter } from "./server/routes/pipeline.routes";
import { companyBrainRouter } from "./server/routes/companyBrain.routes";
import { settingsRouter } from "./server/routes/settings.routes";
import { pitchBattleRouter } from "./server/routes/pitchBattle.routes";
import { campaignsRouter } from "./server/routes/campaigns.routes";
import { autopilotRouter } from "./server/routes/autopilot.routes";
import { meetingsRouter } from "./server/routes/meetings.routes";
import { integrationsRouter } from "./server/routes/integrations.routes";
import { growthCommandRouter } from "./server/routes/growthCommand.routes";
import { webhooksRouter } from "./server/routes/webhooks.routes";
import { quotesRouter } from "./server/routes/quotes.routes";

import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import dotenv from "dotenv";


dotenv.config();

async function startServer() {
  const app = express();
  // Read from PORT, which is how Cloud Run and App Engine say where traffic will arrive. This
  // was the literal 3000, so a platform-assigned port was ignored and the container was never
  // reached. A malformed PORT throws here, before anything binds. See server/config/port.ts.
  const PORT = resolvePort();

  // P0.14 — Raw body capture MUST be mounted before express.json(), otherwise the JSON parser
  // consumes the stream and the signature can only ever be computed over a re-serialised
  // object, which will not match the bytes the provider signed. The per-route express.raw()
  // that used to sit on the signature webhook ran too late for exactly this reason, which is
  // why that endpoint returned 400 for every genuine event.
  //
  // Ordering note: this parser fix is landing TOGETHER with the HMAC verification below.
  // Fixing the parser on its own would convert a permanently-failing endpoint into a working
  // unauthenticated one that any caller could use to mark meetings CONFIRMED.
  // P1.12 — Before everything: an id on every request, echoed in the response header and in
  // every error body, so a user reporting a failure can be traced to a log line without being
  // asked to reproduce it.
  app.use(requestId);

  // S35 — Security headers, including the Content-Security-Policy this application did not
  // have. Mounted here, before anything that can answer a request, so a route added later is
  // covered by default rather than by somebody remembering. `server/middleware/securityHeaders.ts`
  // records which origin each directive exists for and why COOP is `same-origin-allow-popups`
  // rather than `same-origin` — the stricter value silently breaks Google sign-in.
  app.use(securityHeaders());

  app.use('/api/signature/webhook', express.raw({ type: '*/*' }));

  // S35 — the CSP report body, parsed BEFORE the global JSON parser.
  //
  // Browsers send `application/csp-report` (legacy) or `application/reports+json` (Reporting
  // API), and `express.json()` matches neither — so in principle a route-level parser would
  // work. It is mounted here anyway, because S33 is the finding that `express.json()` sets
  // `req._body = true` and silently defeats a route-level parser mounted after it. Relying on
  // "the content types happen not to overlap" is how that bug came back the first time.
  //
  // 16kb: a violation report is a few hundred bytes, and the body is unauthenticated.
  app.use(
    CSP_REPORT_PATH,
    express.json({ limit: '16kb', type: ['application/csp-report', 'application/reports+json', 'application/json'] })
  );

  app.use(express.json());

// P0.4 / S26 — the allowlist of unauthenticated paths moved to
// `server/middleware/authAllowlist.ts` when it stopped being a list of literal strings.
//
// It was `req.path.includes('/webhook')`, a SUBSTRING test that made every path merely
// CONTAINING the word public, including `/api/settings/webhooks`. P0.4 replaced that with an
// exact-match Set. S26's unsubscribe route carries its token in the path, so the allowlist now
// holds a PATTERN as well — and a pattern is precisely what went wrong the first time, so it
// lives in a module a test can interrogate rather than inline here where nothing could.
app.use("/api", (req, res, next) => {
  // req.path is relative to the mount point, but normalise defensively in case this
  // middleware is ever remounted elsewhere.
  const p = req.path.replace(/^\/api/, '') || '/';
  if (isUnauthenticatedApiPath(p)) {
    // P0.5 — Unauthenticated machine endpoints are rate limited by IP. They are the only
    // surfaces reachable without a credential, so they get their own budget.
    return webhookLimiter(req, res, next);
  }
  return requireAuth(req, res, next);
});

// P1.1 — Resolve the tenant once, immediately after authentication and before anything that
// depends on it. Handlers read the answer with orgScope(req); nothing below this line is
// allowed to name an organisation literally.
//
// The unauthenticated machine endpoints are skipped: a webhook has no user, so it has no
// tenant to resolve. Each one is responsible for establishing its own scope from verified
// payload data (see /api/signature/webhook) or refusing to act.
app.use("/api", (req, res, next) => {
  const p = req.path.replace(/^\/api/, '') || '/';
  // The unsubscribe route establishes its own scope from the SIGNED token rather than from a
  // session — the same rule the signature webhook follows: no user, so no tenant to resolve,
  // so it must derive one from verified data or refuse.
  if (isUnauthenticatedApiPath(p)) return next();
  return resolveTenant(req, res, next);
});

// P0.5 — Baseline limit on all authenticated API traffic, then a much tighter budget on the
// endpoints that fan out into paid model calls. Ordering matters: the AI limiter is mounted
// after the general one so an expensive request consumes both budgets.
app.use("/api", standardApiLimiter);
for (const aiPath of [
  "/api/growth-command",
  "/api/company-brain",
  "/api/pitch-battle",
  "/api/inbox/simulate",
  "/api/inbox/generate-reply",
  "/api/campaigns/generate",
]) {
  app.use(aiPath, aiOperationLimiter);
}


  // Health check
  app.use("/api/stripe", stripeRouter);
  app.use("/api/outbox", outboxRouter);

  // The per-conversation autonomy lock. Two places already refused to dispatch when it was
  // set; until this router existed, nothing in the running system could set it — the only
  // writer was a service with no callers. See server/routes/autonomy.routes.ts.
  app.use("/api/autonomy", autonomyRouter);
  // S10 — the audit trail had one writer and no reader anywhere in the repository.
  app.use("/api/actions", actionTrailRouter);
  app.use("/api/spend", spendRouter);
  // S11 — the API described by the server that serves it; generated, committed, drift-checked.
  app.use("/api/openapi.json", openapiRouter);
  // S27 — the sending domain's SPF/DKIM/DMARC posture, the one the gateway consults before a send.
  app.use("/api/deliverability", deliverabilityRouter);
  app.use("/api/unsubscribe", unsubscribeRouter);
  app.use(CSP_REPORT_PATH, cspReportRouter);

  // S39 — every API route lives in a router under server/routes; server.ts mounts them.
  app.use("/api", healthRouter);
  app.use("/api", contactsRouter);
  app.use("/api/inbox", inboxRouter);
  app.use("/api/knowledge", knowledgeRouter);
  app.use("/api", reportingRouter);
  app.use("/api/pipeline", pipelineRouter);
  app.use("/api/company-brain", companyBrainRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/pitch-battle", pitchBattleRouter);
  app.use("/api/campaigns", campaignsRouter);
  app.use("/api/autopilot", autopilotRouter);
  app.use("/api/meetings", meetingsRouter);
  app.use("/api", integrationsRouter);
  app.use("/api/growth-command", growthCommandRouter);
  app.use("/api", webhooksRouter);
  app.use("/api/quotes", quotesRouter);

  // Vite middleware for development / static serving in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));


  app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  outboxWorker.start();
  // S26 — off unless CAMPAIGN_SCHEDULER_ENABLED is exactly "true"; says so in the log when it is not.
  campaignScheduler.start();

  // P1.12 — Terminal error handler. Mounted LAST so nothing gets past it, including an
  // async rejection Express would otherwise leave as an unhandled promise with the request
  // hanging until the client times out. An unrecognised error becomes a generic 500 carrying
  // the requestId; the original goes to the log and never to the caller.
  app.use(terminalErrorHandler);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Abedin Growth AI] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  // Exit non-zero. Logging and returning left a process that either lingered with nothing
  // bound or exited 0, reporting success, and neither is restarted as a crash.
  process.exit(1);
});
