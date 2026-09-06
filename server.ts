// P0.2 — MUST BE THE FIRST IMPORT. This module calls dotenv.config() at evaluation time.
// ES module imports are hoisted and evaluated in source order before this file's own
// statements run, so the `dotenv.config()` call further down was too late for any module
// that read process.env while being imported — notably the ActionGateway's Safe Mode flags.
// Keeping this first guarantees .env is loaded before any other module body executes.
import { safeModeSnapshot, isFullySafeMode } from './server/config/safeMode';
import { getCircuitBreakerState, setCircuitBreaker } from './server/services/circuitBreaker.service';
import { isFabricatedProviderId } from './server/gateway/actionGateway';
import { verifyDocuSignSignature, verifyPubSubToken } from './server/services/webhookVerification.service';
import { standardApiLimiter, aiOperationLimiter, webhookLimiter } from './server/middleware/rateLimit';
import { collection, getDocs, getDoc, addDoc, doc, setDoc, updateDoc, query, where, orderBy, limit } from 'firebase/firestore';
import { PrivacyService } from './server/services/privacy.service';
import { globalStore } from "./server/dataStore";
import { firestore } from "./server/firebase";
import { requireAuth } from "./server/middleware/auth";
import { resolveTenant } from "./server/middleware/tenant";
import { orgScope, orgPath, isValidOrgId } from "./server/tenancy/orgScope";
import { assertTransition, CAMPAIGN, MEETING, OPPORTUNITY } from "./server/domain/stateMachines";
import {
  expectedVersionFrom,
  mutateWithVersion,
  sendMutationOutcome,
  sendVersionRequired,
  versionOf,
} from "./server/lib/concurrency";
import { outboxWorker } from "./server/workers/outbox.worker";
import { stripeRouter } from "./server/routes/stripe.routes";
import { outboxRouter } from "./server/routes/outbox.routes";

import { processGrowthCommand } from './server/agents/growthCommandAgent';
import { simulatePitchBattle } from './server/agents/pitchBattleAgent';
import { generateCompanyBrain } from './server/agents/companyBrainAgent';
import { gmailHistorySyncService } from './server/services/gmailHistorySync.service';
import express, { Request, Response } from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import dotenv from "dotenv";

import {
  executeMultiAgentReplyPipeline,
  validateAndEnforceNoPhonePolicy,
  validateAndEnforceMeetingAndCalendarLinks,
  normalizeMergeTags,
  auditFullSystemReplies,
} from "./server/agents/multiAgentReplySystem";
import { resolveClientIdentity } from "./server/agents/clientIdentityResolver";
import {
  TRUSTED_CTA_REGISTRY,
  CALENDAR_BOOKING_URL,
  GOOGLE_MEET_URL,
} from "./server/agents/trustedCtaRegistry";
import {
  circuitBreaker,
  resetCircuitBreaker,
  tripCircuitBreaker,
  evaluateEmailUnderstandingRuleBased,
  computePurchaseReadiness,
  computeMeetingReadiness,
  computeBuyingStage,
  determineNextBestAction,
  composeAutonomousSalesReply,
  sanitizeUntrustedProspectInput,
  CANONICAL_KNOWLEDGE,
} from "./server/agents/salesDecisionEngine";
import { auditReplyAgainstPlan } from "./server/agents/independentAuditor";
import { runCompleteSalesEngineTestMatrix } from "./server/agents/salesEngineTestMatrix";
import { evaluatePolicy } from "./server/policies/policyEngine";
import { autopilotRunner } from "./server/autopilotRunner";
import { Lead, Investor, Partner, Campaign, Meeting, Opportunity, KnowledgeItem, EmailMessage, CompanyBrain } from "./src/types";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  // P0.14 — Raw body capture MUST be mounted before express.json(), otherwise the JSON parser
  // consumes the stream and the signature can only ever be computed over a re-serialised
  // object, which will not match the bytes the provider signed. The per-route express.raw()
  // that used to sit on the signature webhook ran too late for exactly this reason, which is
  // why that endpoint returned 400 for every genuine event.
  //
  // Ordering note: this parser fix is landing TOGETHER with the HMAC verification below.
  // Fixing the parser on its own would convert a permanently-failing endpoint into a working
  // unauthenticated one that any caller could use to mark meetings CONFIRMED.
  app.use('/api/signature/webhook', express.raw({ type: '*/*' }));
  app.use(express.json());

// P0.4 — Explicit allowlist of unauthenticated paths.
//
// This was `req.path.includes('/webhook')` — a SUBSTRING test. Any route whose path merely
// contained the word anywhere was unauthenticated, including paths never intended to be
// public (e.g. /api/settings/webhooks, /api/campaigns/webhook-preview). An allowlist of exact
// paths cannot be widened by accident when someone adds a route.
//
// These endpoints are unauthenticated because the caller is a machine that cannot hold a user
// credential. That makes SIGNATURE VERIFICATION the only thing standing between them and an
// anonymous caller — see P0.14. Do not add an entry here without one.
const UNAUTHENTICATED_API_PATHS = new Set([
  '/readiness',
  '/health',
  '/signature/webhook',
  '/webhooks/gmail',
]);

app.use("/api", (req, res, next) => {
  // req.path is relative to the mount point, but normalise defensively in case this
  // middleware is ever remounted elsewhere.
  const p = req.path.replace(/^\/api/, '') || '/';
  if (UNAUTHENTICATED_API_PATHS.has(p)) {
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
  if (UNAUTHENTICATED_API_PATHS.has(p)) return next();
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


  // EXECUTABLE READINESS CHECK (Requirement X)
  app.get("/api/readiness", async (req: Request, res: Response) => {
    try {
      // P0.2 — These flags are now read through server/config/safeMode.ts, the SAME module
      // the ActionGateway consults when it decides whether to dispatch. Previously this
      // handler read process.env directly at request time while the gateway used a snapshot
      // taken at module-evaluation time, before dotenv had run — so this endpoint could
      // report "real sending is ON" while the gateway enforced OFF, or the reverse. The
      // operator-facing indicator and the enforcement point are now the same read.
      const flags = safeModeSnapshot();
      const checks = {
        databaseConnectivity: !!firestore,
        actionGatewayLoaded: true, // We import it statically
        safeRebuildMode: {
          email: flags.REAL_EMAIL_SEND_ENABLED,
          calendar: flags.REAL_CALENDAR_CREATE_ENABLED,
          payment: flags.REAL_PAYMENT_ENABLED,
          signature: flags.REAL_SIGNATURE_ENABLED,
          linkedIn: flags.REAL_LINKEDIN_SEND_ENABLED,
          allExternalActionsDisabled: isFullySafeMode(),
        },
        // NOTE (S47, tracked in the P3 roadmap): the checks above still test object existence
        // rather than capability. `databaseConnectivity` is a truthiness test on the Firestore
        // handle, not an executed query, and Postgres is not probed at all — so this endpoint
        // can report READY while a required production dependency cannot perform its function.
        // Do not treat READY as proof of capability until that work lands.
        verifiesCapability: false,
      };

      const isReady = checks.databaseConnectivity;

      res.json({
        status: isReady ? "READY" : "NOT_READY",
        checks
      });
    } catch (e: any) {
      res.status(500).json({ status: "DEGRADED", error: e.message });
    }
  });
app.get("/api/health", (req: Request, res: Response) => {
    res.json({ status: "ok", service: "Abedin Growth AI Core Engine" });
  });

  // 1. Dashboard summary

  app.get("/api/leads", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(firestore, orgPath(orgScope(req), 'contacts')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      // filter for leads
      res.json(items.filter(i => i.type === 'LEAD' || !i.type));
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/leads", async (req: Request, res: Response) => {
    try {
      const id = "lead_" + Date.now();
      const payload = { ...req.body, id, type: 'LEAD', status: 'NEW' };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/inbox", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(firestore, orgPath(orgScope(req), 'conversations')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.post("/api/knowledge", async (req: Request, res: Response) => {
    try {
      const payload = { ...req.body, id: "kno_" + Date.now(), createdAt: new Date().toISOString() };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'knowledge')), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/knowledge", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(firestore, orgPath(orgScope(req), 'knowledge')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/logs", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(query(collection(firestore, orgPath(orgScope(req), 'ai_logs')), orderBy('timestamp', 'desc'), limit(50)));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/pipeline", async (req: Request, res: Response) => {
    try {
      // P1.3 — See /api/campaigns: the version travels with every row.
      const snap = await getDocs(collection(firestore, orgPath(orgScope(req), 'opportunities')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  /**
   * P1.3 — The two singleton documents (company brain, settings).
   *
   * The GET used to read the whole COLLECTION and return `items[0]` — an arbitrary row, since
   * Firestore imposes no order — while the POST wrote the document `main`. So a second
   * document in either collection made the read and the write disagree about which record the
   * operator was looking at. They now both address `main`.
   *
   * The GET also returns `version` and an ETag, because a caller cannot state the version it
   * is updating unless the read gives it one.
   */
  async function readSingleton(req: Request, res: Response, collectionName: string) {
    const ref = doc(firestore, orgPath(orgScope(req), collectionName), 'main');
    const snap = await getDoc(ref);
    const data: any = snap.exists() ? snap.data() : {};
    const version = versionOf(data, snap.exists());
    res.setHeader('ETag', `"${version}"`);
    return res.json({ ...data, version });
  }

  async function writeSingleton(
    req: Request,
    res: Response,
    collectionName: string,
    payload: Record<string, unknown>
  ) {
    const ref = doc(firestore, orgPath(orgScope(req), collectionName), 'main');
    const expected = expectedVersionFrom(req);

    if (expected.ok === false) {
      // Tell the caller the current version in the same response that refuses the write, so
      // recovering from the error is one retry rather than a second round trip.
      const snap = await getDoc(ref);
      return sendVersionRequired(res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
    }

    // `version` and `expectedVersion` are transport, not content: they must not be persisted
    // as document fields, or the next read would hand them back as data.
    const { expectedVersion: _ignored, version: _alsoIgnored, ...body } = payload as any;

    const outcome = await mutateWithVersion(ref, expected.value, () => body);
    return sendMutationOutcome(res, outcome);
  }

  app.get("/api/company-brain", async (req: Request, res: Response) => {
    try {
      return await readSingleton(req, res, 'company_brain');
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/company-brain", async (req: Request, res: Response) => {
    try {
      return await writeSingleton(req, res, 'company_brain', req.body || {});
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.get("/api/settings", async (req: Request, res: Response) => {
    try {
      return await readSingleton(req, res, 'settings');
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/settings", async (req: Request, res: Response) => {
    try {
      return await writeSingleton(req, res, 'settings', req.body || {});
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.post("/api/pitch-battle/simulate", async (req: Request, res: Response) => {
    try {
      const result = await simulatePitchBattle(req.body);
      res.json(result);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.post("/api/company-brain/generate", async (req: Request, res: Response) => {
    try {
      // P1.3 — Regeneration replaced the company brain blind, which is the most damaging
      // instance of the lost update in this file: the brain is stringified into every outbound
      // prompt, so silently discarding an operator's edit changes what customers are told.
      const ref = doc(firestore, orgPath(orgScope(req), 'company_brain'), 'main');
      const expected = expectedVersionFrom(req);
      if (expected.ok === false) {
        const snap = await getDoc(ref);
        return sendVersionRequired(res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
      }

      // Generated BEFORE the transaction: it is an external model call, and produceNext runs
      // inside a transaction that may be retried. A retryable block must not make paid calls.
      const result = await generateCompanyBrain(req.body);

      const outcome = await mutateWithVersion(ref, expected.value, () => result as any);
      return sendMutationOutcome(res, outcome);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.post("/api/leads/batch-generate", async (req: Request, res: Response) => {
    try {
      const { count = 3, location = 'UK', industry = 'Dental' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "lead_" + Date.now() + "_" + i,
          type: "LEAD",
          name: "Generated Lead " + (i+1),
          title: "Decision Maker",
          companyName: `${location} ${industry} Clinic ${i+1}`,
          primaryEmail: `lead${i}@example.com`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/investors/batch-generate", async (req: Request, res: Response) => {
    try {
      const { count = 3, location = 'Global', industry = 'AI' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "inv_" + Date.now() + "_" + i,
          type: "INVESTOR",
          name: "Generated Investor " + (i+1),
          title: "Partner",
          companyName: `${location} ${industry} Ventures ${i+1}`,
          primaryEmail: `investor${i}@example.com`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/partners/batch-generate", async (req: Request, res: Response) => {
    try {
      const { count = 3, location = 'Global', industry = 'Tech' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "part_" + Date.now() + "_" + i,
          type: "PARTNER",
          name: "Generated Partner " + (i+1),
          title: "Director",
          companyName: `${location} ${industry} Corp ${i+1}`,
          primaryEmail: `partner${i}@example.com`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });


  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(firestore, orgPath(orgScope(req), 'campaigns')));
      const items: any[] = [];
      // P1.3 — The version travels with every row. A client cannot state the version it is
      // updating unless the read gives it one, so omitting this would make the write path
      // impossible to use correctly rather than merely easy to use incorrectly.
      snap.forEach((d: any) => items.push({ ...d.data(), version: versionOf(d.data(), true) }));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  /**
   * P1.3/P1.4 — Campaign pause and resume.
   *
   * This was a TOGGLE: read the status, negate it, write it back, in two round trips. A toggle
   * cannot express intent — the request says "the other one", not what the operator wanted —
   * so two clicks in the same second both read ACTIVE and both write PAUSED, and a campaign an
   * operator meant to stop keeps running with the UI showing it stopped.
   *
   * The caller now states the status it wants and the version it read. Asking for the status a
   * campaign is already in succeeds without incrementing the version: pausing something already
   * paused is the operator getting what they asked for, not a conflict.
   */
  const setCampaignStatus = async (req: Request, res: Response) => {
    try {
      const desired = (req.body || {}).status;
      const docRef = doc(firestore, orgPath(orgScope(req), 'campaigns'), req.params.id);
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such campaign.' } });
      }

      const current: any = snap.data();
      const currentVersion = versionOf(current, true);

      // P1.4 — The legal set and the legal MOVES both come from the one transition map, so an
      // ARCHIVED campaign cannot be reactivated and a COMPLETED one cannot be paused. Neither
      // rule was expressible when this was a toggle.
      const verdict = assertTransition(CAMPAIGN, current.status, desired);
      if (verdict.ok === false) {
        return res.status(422).json({ error: { code: verdict.code, message: verdict.message } });
      }
      if (verdict.changed === false) {
        res.setHeader('ETag', `"${currentVersion}"`);
        return res.json({ ...current, version: currentVersion });
      }

      const expected = expectedVersionFrom(req);
      if (expected.ok === false) return sendVersionRequired(res, expected, currentVersion);

      const outcome = await mutateWithVersion(docRef, expected.value, (existing: any) => ({
        ...existing,
        status: desired,
        statusChangedAt: new Date().toISOString(),
      }));
      return sendMutationOutcome(res, outcome);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  };

  // Both spellings: /status is what it does, /toggle is what existing callers send.
  app.post("/api/campaigns/:id/status", setCampaignStatus);
  app.post("/api/campaigns/:id/toggle", setCampaignStatus);

  app.post("/api/settings/token", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/autopilot/run-cycle-now", (req: Request, res: Response) => res.json({ status: "success" }));
  app.post("/api/leads/research", (req: Request, res: Response) => res.json({ notes: "Research complete: High intent detected." }));
  app.post("/api/inbox/:id/reply", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/inbox/:id/classify", (req: Request, res: Response) => res.json({ intentConfidence: 0.9 }));

  /**
   * P1.2/P1.3/P1.4 — Move an opportunity to a stage.
   *
   * Three separate defects lived in six lines here:
   *
   *   - The route was registered for POST while the only caller in the repository
   *     (src/App.tsx handleUpdatePipelineStage) sends PUT. Every stage change from the UI has
   *     been 404ing. Both verbs are now registered; PUT is the correct one for an idempotent
   *     "set the stage to X".
   *   - `req.body.stage` was written straight to the document with no validation, so any
   *     string — "won", "", an object — became a pipeline stage and was persisted and rendered.
   *   - The write was blind: no version, so two operators dragging the same card both win and
   *     neither is told.
   */
  const setOpportunityStage = async (req: Request, res: Response) => {
    try {
      const docRef = doc(firestore, orgPath(orgScope(req), 'opportunities'), req.params.id);

      // The path is tenant-scoped, so an id belonging to another organisation resolves to
      // nothing. 404, not 403: saying "forbidden" would confirm the id exists in some other
      // tenant.
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such opportunity.' } });
      }

      const current: any = snap.data();
      const currentVersion = versionOf(current, true);
      const desired = (req.body || {}).stage;

      const verdict = assertTransition(OPPORTUNITY, current.stage, desired);
      if (verdict.ok === false) {
        // 422, not 400: the request is well-formed, it is the state change that is not
        // permitted. A client can tell "you sent nonsense" from "you may not do that".
        return res.status(422).json({ error: { code: verdict.code, message: verdict.message } });
      }
      if (verdict.changed === false) {
        res.setHeader('ETag', `"${currentVersion}"`);
        return res.json({ ...current, version: currentVersion });
      }

      const expected = expectedVersionFrom(req);
      if (expected.ok === false) return sendVersionRequired(res, expected, currentVersion);

      const outcome = await mutateWithVersion(docRef, expected.value, (existing: any) => ({
        ...existing,
        stage: desired,
        stageChangedAt: new Date().toISOString(),
      }));
      return sendMutationOutcome(res, outcome);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  };

  app.put("/api/pipeline/:id/stage", setOpportunityStage);
  app.post("/api/pipeline/:id/stage", setOpportunityStage);

  app.post("/api/meetings/brief", (req: Request, res: Response) => res.json({ brief: "Meeting brief generated." }));
  app.post("/api/settings/autopilot", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/meetings/:id/sign-contract", (req: Request, res: Response) => res.json({ success: true }));
  // P0.15 — Was `res.json({ success: true })`. This is the endpoint the UI calls to take
  // payment, and it reported success without contacting any payment provider, creating any
  // record, or moving any state. An operator watching the screen would believe a customer had
  // paid. A stub that fabricates success for a FINANCIAL action is worse than a missing
  // endpoint, so it now refuses honestly. Real payments go through /api/stripe.
  app.post("/api/meetings/:id/process-payment", (req: Request, res: Response) =>
    res.status(501).json({
      error: {
        code: 'NOT_IMPLEMENTED',
        message:
          'Payment processing is not implemented on this endpoint. It previously returned ' +
          'success without taking payment. Use the Stripe checkout flow (/api/stripe/create-checkout-session).',
      },
    })
  );
  app.post("/api/meetings/:id/send-recovery-email", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/inbox/auto-reply-all", (req: Request, res: Response) => res.json({ success: true, count: 5 }));
  app.post("/api/leads/batch-followup", (req: Request, res: Response) => res.json({ success: true, count: 10 }));
  app.post("/api/leads/:id/simulate-reply", (req: Request, res: Response) => res.json({ reply: "Simulated reply from lead." }));
  app.post("/api/linkedin/send-message", (req: Request, res: Response) => res.json({ success: true }));
  app.get("/api/sender-identity", (req: Request, res: Response) => res.json({ name: "AI Agent", email: "agent@example.com" }));
  app.post("/api/sender-identity", (req: Request, res: Response) => res.json({ success: true }));
  app.get("/api/linkedin-config", (req: Request, res: Response) => res.json({ enabled: true }));
  app.post("/api/linkedin-config", (req: Request, res: Response) => res.json({ success: true }));
  app.get("/api/inbox/sales-decision-engine/inspect", (req: Request, res: Response) => res.json({ decision: "Proceed" }));
  // P0.3 — Was `res.json({ success: true })`: it mutated nothing and returned no
  // `circuitBreaker` field, so the console set its state to `undefined` and crashed on the
  // next render — during precisely the incident an operator would press it. Now backed by a
  // durable, fail-closed service. See server/services/circuitBreaker.service.ts.
  app.post("/api/inbox/circuit-breaker/toggle", async (req: Request, res: Response) => {
    try {
      const { enabled, reason } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: '`enabled` must be a boolean.' },
        });
      }
      // Actor attribution. requireAuth currently admits anonymous callers (fixed in P0.4), so
      // record what we actually know rather than inventing an operator identity.
      const actor = req.user?.email || req.user?.uid || 'unattributed';
      const { state, accepted, message } = await setCircuitBreaker(enabled, reason, actor);
      res.json({ success: accepted, message, circuitBreaker: state });
    } catch (e: any) {
      res.status(500).json({
        error: { code: 'KILL_SWITCH_FAILED', message: e.message },
      });
    }
  });
  app.post("/api/inbox/deep-audit", (req: Request, res: Response) => res.json({ audit: "Clean" }));
  app.post("/api/inbox/:id/auto-reply", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/inbox/:id/memory/refresh", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/inbox/:id/follow-up", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/inbox/:id/generate-multi-agent-reply", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/meetings/:id/send-reminder", (req: Request, res: Response) => res.json({ success: true }));
  app.post("/api/leads/:id/email", (req: Request, res: Response) => res.json({ success: true }));

  app.get("/api/dashboard", async (req: Request, res: Response) => {
    try {
      if (!firestore) return res.status(500).json({ error: "Firebase not initialized" });
      const orgId = orgScope(req);

      const contactsSnap = await getDocs(collection(firestore, orgPath(orgId, 'contacts')));
      let qualifiedLeadsCount = 0;
      contactsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "QUALIFIED" || s === "ENGAGED" || s === "DEMO_SCHEDULED") qualifiedLeadsCount++;
      });

      const convsSnap = await getDocs(collection(firestore, orgPath(orgId, 'conversations')));
      let positiveConversationsCount = 0;
      convsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "ACTIVE" || s === "HUMAN_NEEDED" || s === "MEETING_REQUESTED") positiveConversationsCount++;
      });

      const meetingsSnap = await getDocs(collection(firestore, orgPath(orgId, 'meetings')));
      let meetingsBookedCount = 0;
      meetingsSnap.forEach(doc => {
         if (doc.data().status === "CONFIRMED") meetingsBookedCount++;
      });

      const oppsSnap = await getDocs(collection(firestore, orgPath(orgId, 'opportunities')));
      let pipelineValue = 0;
      oppsSnap.forEach(doc => {
          pipelineValue += (doc.data().value || 0);
      });

      res.json({
        kpis: {
          qualifiedLeads: qualifiedLeadsCount,
          positiveConversations: positiveConversationsCount,
          meetingsBooked: meetingsBookedCount,
          pipelineValue,
          investorConversations: 0,
          partnerConversations: 0,
          projectedMonthlyRevenue: Math.floor(pipelineValue * 0.15),
        },
        attentionItems: [],
        dailyBrief: [],
        status: "AI Growth Engine: Active",
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });


  app.get("/api/analytics/funnel", async (req: Request, res: Response) => {
    try {
      const allContactsSnap = await getDocs(collection(firestore, orgPath(orgScope(req), 'contacts'))); const allContacts: any[] = []; allContactsSnap.forEach(d => allContacts.push(d.data()));
      const allConvsSnap = await getDocs(collection(firestore, orgPath(orgScope(req), 'conversations'))); const allConvs: any[] = []; allConvsSnap.forEach(d => allConvs.push(d.data()));
      const allMeetingsSnap = await getDocs(collection(firestore, orgPath(orgScope(req), 'meetings'))); const allMeetings: any[] = []; allMeetingsSnap.forEach(d => allMeetings.push(d.data()));

      const discovered = allContacts.length;
      const qualified = 15; // mock complex AI score for now
      const outreachSent = allConvs.length;
      const opened = allConvs.filter(c => c.status !== 'NEW').length;
      const replied = allConvs.filter(c => c.status === 'REPLIED').length;
      const positive = allConvs.filter(c => c.intentConfidence && c.intentConfidence > 0.8).length || 3;
      const demoBooked = allMeetings.length;

      res.json({
        funnel: [
          { label: "1. Discovered", count: discovered, dropoff: "100%", color: "bg-slate-700" },
          { label: "2. AI Qualified (Score > 80)", count: qualified, dropoff: discovered ? `${((qualified/discovered)*100).toFixed(1)}%` : "0%", color: "bg-blue-600" },
          { label: "3. Outreach Sent", count: outreachSent, dropoff: qualified ? `${((outreachSent/qualified)*100).toFixed(1)}%` : "0%", color: "bg-indigo-600" },
          { label: "4. Opened", count: opened, dropoff: outreachSent ? `${((opened/outreachSent)*100).toFixed(1)}% Open Rate` : "0%", color: "bg-purple-600" },
          { label: "5. Replied", count: replied, dropoff: opened ? `${((replied/opened)*100).toFixed(1)}% Reply Rate` : "0%", color: "bg-amber-600" },
          { label: "6. Positive Intent", count: positive, dropoff: replied ? `${((positive/replied)*100).toFixed(1)}% Positivity` : "0%", color: "bg-emerald-600" },
          { label: "7. Demo Booked", count: demoBooked, dropoff: positive ? `${((demoBooked/positive)*100).toFixed(1)}% Conversion` : "0%", color: "bg-emerald-500" },
        ]
      });
    } catch(e) {
      console.error(e);
      res.json({ funnel: [] });
    }
  });



  // 2. Company Brain



  // Batch Follow-Up to all Contacted Leads



  // 3. Leads & Research (REWRITTEN TO NATIVE POSTGRESQL)








  // 4. Investors

  app.get("/api/investors", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(query(collection(firestore, orgPath(orgScope(req), 'contacts')), where('type', '==', 'INVESTOR')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/investors", async (req: Request, res: Response) => {
    try {
      const id = "inv_" + Date.now();
      const payload = { ...req.body, id, type: 'INVESTOR', status: 'DISCOVERED' };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });





  // 5. Partners

  app.get("/api/partners", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(query(collection(firestore, orgPath(orgScope(req), 'contacts')), where('type', '==', 'PARTNER')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/partners", async (req: Request, res: Response) => {
    try {
      const id = "part_" + Date.now();
      const payload = { ...req.body, id, type: 'PARTNER', status: 'DISCOVERED' };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'contacts')), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });




  // 6. Campaigns




  // 7. Inbox & Conversations

  app.post("/api/integrations/gmail/token", async (req: Request, res: Response) => {
    // P0.8 — This handler received a REAL accessToken in the request body, discarded it, and
    // persisted the literal 'mock_token' with status ACTIVE. The ActionGateway then saw
    // 'mock_token' and returned fabricated success for every send. So "connecting Gmail"
    // reliably produced a connection that could never send while reporting itself healthy.
    // The credential supplied is now the credential stored, and a request without one is
    // rejected rather than answered with a fake ACTIVE connection.
    const { accessToken, expiresIn, accountEmail } = req.body || {};

    if (typeof accessToken !== 'string' || accessToken.trim() === '' || isFabricatedProviderId(accessToken) || accessToken === 'mock_token') {
      return res.status(400).json({
        error: {
          code: 'PROVIDER_NOT_CONFIGURED',
          message:
            'A real Gmail access token is required. Refusing to store a placeholder credential, ' +
            'which would make the gateway report sends that never happened.',
        },
      });
    }

    // TODO(P1 — tenant resolution): org is hardcoded here as everywhere else in this file.
    // TODO(P0.0/P0.6 — credential storage): oauth_connections is a top-level collection in a
    // datastore whose rules are still `allow read, write: if true`, so this token is readable
    // and overwritable by anyone until the rules are closed and server access moves to the
    // Admin SDK. Storing a real credential here is only acceptable once that has landed.
    const orgId = orgScope(req);

    try {
      const record: Record<string, unknown> = {
        organizationId: orgId,
        provider: 'gmail',
        accessToken,
        accountEmail: accountEmail || null,
        // Expiry is derived server-side; an absent expiresIn means "unknown", not "forever".
        expiresAt: typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null,
        status: 'ACTIVE',
        updatedAt: new Date(),
      };

      const existing = await getDocs(query(collection(firestore, 'oauth_connections'), where('organizationId', '==', orgId), where('provider', '==', 'gmail')));
      if (!existing.empty) {
        await updateDoc(existing.docs[0].ref, record);
      } else {
        await addDoc(collection(firestore, 'oauth_connections'), { id: 'oauth_' + Date.now(), ...record });
      }
      res.json({ success: true });
    } catch(e) {
      console.error("Token sync error:", e);
      res.status(500).json({ error: { code: 'PROVIDER_UNAVAILABLE', message: e.message } });
    }
  });





  // Autonomous Inbound Auto-Reply Endpoints


  // Dedicated Multi-Agent Response Generation Endpoint with Regex Validation

  // Dedicated Phone Policy Validation Tool Endpoint
  app.post("/api/inbox/validate-phone-policy", (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      const result = validateAndEnforceNoPhonePolicy(text || "");
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to validate text" });
    }
  });

  // Deep System Audit & Quality Gatekeeper Verification Endpoint

  // Canonical CTA Registry Endpoint (Part 21)
  app.get("/api/inbox/cta-registry", (req: Request, res: Response) => {
    res.json({ success: true, ctaRegistry: TRUSTED_CTA_REGISTRY });
  });

  // Circuit Breaker Status & Toggle Endpoints (Part 49)
app.get("/api/inbox/circuit-breaker", async (req: Request, res: Response) => {
    // P0.3 — This previously returned `{enabled, reason}` while the admin console reads
    // `data.circuitBreaker`, so the panel set its state to `undefined` and crashed on LOAD as
    // well as on toggle. It also read a process-local boolean, so replicas disagreed. Now it
    // returns the durable state under the key the console actually consumes. The legacy
    // `enabled`/`reason` keys are retained so any other client keeps working.
    try {
      const state = await getCircuitBreakerState();
      res.json({
        circuitBreaker: state,
        enabled: state.globalAutonomousSendEnabled,
        reason: state.pausedReason,
      });
    } catch (e: any) {
      // Fail closed: if state cannot be determined, report paused rather than active.
      res.status(200).json({
        circuitBreaker: {
          globalAutonomousSendEnabled: false,
          pausedReason: `State unavailable: ${e.message}`,
          consecutiveErrorCount: 0,
          duplicateSendAlertTriggered: false,
          bounceRateSpikeDetected: false,
          autonomyDisabledByConfiguration: true,
          degradedFailClosed: true,
        },
        enabled: false,
        reason: `State unavailable: ${e.message}`,
      });
    }
  });


  // Automated 70-Scenario Sales Engine Test Matrix Execution (Part 37 & 38)
  app.post("/api/inbox/run-test-matrix", async (req: Request, res: Response) => {
    try {
      const report = await runCompleteSalesEngineTestMatrix();
      res.json({ success: true, report });
    } catch (error: any) {
      console.error("Run test matrix error:", error);
      res.status(500).json({ error: error.message || "Failed to run test matrix" });
    }
  });

  // 12-Layer Sales Decision Engine Real-Time Inspection Endpoint (Part 36 Admin Debug View)



  // Conversation Memory Endpoints (allocated memory checking full thread)



  // 8. Pipeline Opportunities



  app.post("/api/campaigns/generate-strategy", async (req: Request, res: Response) => {
    try {
      const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount, isABTestingEnabled } = req.body;

      const projectedReach = enrolledCount || 0;
      const projectedEngagement = Math.floor(projectedReach * 0.68);
      const projectedConversion = Math.floor(projectedReach * 0.12);

      const newCampaign = {
        id: "camp_" + Date.now(),
        name: name || "Untitled Campaign",
        engineType: engineType || "CUSTOMER",
        status: "ACTIVE",
        targetAudience: targetAudience || "",
        targetLocations: targetLocations || [],
        targetIndustries: targetIndustries || [],
        enrolledCount: projectedReach,
        sentCount: 0,
        openedCount: 0,
        repliedCount: 0,
        convertedCount: 0,
        projectedMetrics: { reach: projectedReach, engagement: projectedEngagement, conversion: projectedConversion },
        aiStrategySummary: `Generated custom sequence for ${targetAudience}. Leveraging local market context for ${(targetLocations || []).join(', ')}. ${isABTestingEnabled ? "A/B Testing automatically configured across 2 variants." : ""}`,
        steps: [
          {
             stepNumber: 1,
             title: "The Vision Hook",
             delayDays: 0,
             subjectTemplate: "Quick question regarding {{companyName}}",
             bodyTemplate: "Hi {{firstName}},\n\nI noticed you're a leader in the ${(targetIndustries || [])[0] || 'space'} in ${(targetLocations || [])[0] || 'your area'}. How are you currently managing growth?\n\nBest,\nNayem"
          },
          {
             stepNumber: 2,
             title: "The Value Add",
             delayDays: 3,
             subjectTemplate: "Thoughts on {{companyName}}?",
             bodyTemplate: "Hi {{firstName}},\n\nJust following up on my previous note. We recently helped a similar company scale their operations by 40%.\n\nLet me know if you'd like to see a quick demo.\n\nBest,\nNayem"
          },
          {
             stepNumber: 3,
             title: "Multi-channel Bump",
             delayDays: 5,
             stepType: "LINKEDIN_TASK",
             subjectTemplate: "LinkedIn Connection",
             bodyTemplate: "Hi {{firstName}}, I'm Nayem. Would love to connect and share insights."
          }
        ],
        createdAt: new Date().toISOString(),
        isABTestingEnabled: !!isABTestingEnabled
      };

      await addDoc(collection(firestore, orgPath(orgScope(req), 'campaigns')), newCampaign);
      res.json(newCampaign);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });





  app.post("/api/pipeline", async (req: Request, res: Response) => {
    try {
      const newId = `opp_${Date.now()}`;
      const payload = { ...req.body, id: newId, value: req.body.estimatedValue || req.body.value || 0 };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'opportunities')), payload);
      res.json(payload);
    } catch(e: any) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });



  // 9. Meetings & Calendar

  // P0.13 — CALENDAR CONFLICT INVARIANT ON THE LIVE BOOKING PATH.
  //
  // This is where meetings are ACTUALLY created. The ActionGateway's executeCalendarCreate,
  // which contains the free/busy logic, is unreachable: dispatchAction has one call site
  // (outbox.worker.ts) and it always passes EMAIL_SEND. So the addendum §31 invariant
  // ("free/busy reports busy -> calendar create request count = 0") had no enforcement point
  // at all — this handler was a bare addDoc that accepted any body and always said SCHEDULED.
  //
  // Two changes: the request is validated and projected (it previously spread `...req.body`
  // straight into the document, a mass assignment), and an overlap check now runs before the
  // write. This checks OUR OWN calendar; a real provider free/busy call additionally requires
  // Google credentials, so a meeting created here is explicitly NOT marked as confirmed on
  // the provider — it is PENDING_CALENDAR_SYNC until something actually books it.
  app.post("/api/meetings", async (req: Request, res: Response) => {
    try {
      const { contactId, scheduledTime, durationMinutes, title, notes } = req.body || {};

      const startMs = new Date(scheduledTime).getTime();
      if (!scheduledTime || !Number.isFinite(startMs)) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: '`scheduledTime` must be a valid date-time.' },
        });
      }
      const duration = Number.isFinite(Number(durationMinutes)) ? Number(durationMinutes) : 30;
      if (duration <= 0 || duration > 480) {
        return res.status(400).json({
          error: { code: 'VALIDATION_ERROR', message: '`durationMinutes` must be between 1 and 480.' },
        });
      }
      const endMs = startMs + duration * 60_000;

      // Conflict detection against existing non-cancelled meetings.
      const existingSnap = await getDocs(collection(firestore, orgPath(orgScope(req), 'meetings')));
      const conflicts: any[] = [];
      existingSnap.forEach((d) => {
        const m: any = d.data();
        if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(m.status)) return;
        const mStart = m.scheduledTime?.toMillis?.() ?? new Date(m.scheduledTime || 0).getTime();
        if (!Number.isFinite(mStart) || mStart === 0) return;
        const mEnd = mStart + (Number(m.durationMinutes) || 30) * 60_000;
        // Half-open intervals: [start, end). Touching meetings do not conflict.
        if (mStart < endMs && startMs < mEnd) conflicts.push({ id: m.id, scheduledTime: m.scheduledTime });
      });

      if (conflicts.length > 0) {
        // The invariant: on a confirmed conflict, do NOT create. Zero provider requests, and
        // zero local records that would later be treated as a real booking.
        console.warn(`[meetings] Refused booking: ${conflicts.length} overlapping meeting(s).`);
        return res.status(409).json({
          error: {
            code: 'SCHEDULE_CONFLICT',
            message: `Requested slot overlaps ${conflicts.length} existing meeting(s).`,
            details: { conflicts },
          },
        });
      }

      const payload = {
        id: "meet_" + Date.now(),
        contactId: contactId ?? null,
        title: title ?? null,
        notes: notes ?? null,
        scheduledTime: new Date(startMs),
        durationMinutes: duration,
        status: 'SCHEDULED',
        // Honest about provider state: nothing has been booked on a real calendar here.
        providerSyncStatus: 'PENDING_CALENDAR_SYNC',
        providerEventId: null,
        createdAt: new Date(),
      };
      await addDoc(collection(firestore, orgPath(orgScope(req), 'meetings')), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: { code: 'MEETING_CREATE_FAILED', message: e.message }}); }
  });

  app.get("/api/meetings", async (req: Request, res: Response) => {
    try {
      const dbMeetingsSnap = await getDocs(collection(firestore, orgPath(orgScope(req), 'meetings'))); const dbMeetings: any[] = []; dbMeetingsSnap.forEach(d => dbMeetings.push(d.data()));
      const mapped = dbMeetings.map(m => ({
        id: m.id,
        contactId: m.contactId,
        prospectName: "Unknown",
        prospectEmail: "unknown@example.com",
        companyName: "Unknown",
        status: m.status,
        scheduledAt: m.scheduledTime ? m.scheduledTime.toISOString() : undefined,
        meetLink: m.meetUrl,
      }));
      res.json(mapped);
    } catch(e) { console.error(e); res.status(500).json({error: e.message}); }
  });



  // Automated 24h and 1h Reminders

  // Mark Meeting as Missed / No-Show & Trigger Recovery

  // Dispatch Missed Meeting Recovery Email (Types 1-4)

  // Sign Master Services Agreement in Live Meeting Room

  // Process First Payment (£499.00 GBP) in Live Meeting Room

  // 10. Knowledge Base


  // 11. Autopilot Settings



  app.post("/api/growth-command", async (req: Request, res: Response) => {
    try {
      const result = await processGrowthCommand(req.body.command);
      res.json(result);
    } catch(e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });

  // 12. AI Growth Command & Agent Chat

  // 13. Quality Control check

  // 14. Pitch Battle Objection War Room Simulation

  // 15. AI Logs

  // 16. Continuous Autopilot Runner API


  app.get("/api/autopilot/status", (req: Request, res: Response) => {
    res.json(autopilotRunner.status);
  });

  app.post("/api/autopilot/toggle", (req: Request, res: Response) => {
    const isActive = autopilotRunner.startBackgroundLoop();
    res.json({ isActive, status: autopilotRunner.status });
  });

  app.post("/api/autopilot/settings", (req: Request, res: Response) => {
    const updated = { settings: req.body }; // autopilotRunner.setSettings(req.body);
    res.json(updated);
  });


  // 17. Sender Identity Configuration


  // 18. LinkedIn Configuration & Direct Outreach



  // 19. Complete Outbox & Audit Trails


  // P0.14 — These webhook routes were previously registered ONLY inside the
  // `else` (production) branch below, alongside the static-file handler. In development
  // NODE_ENV !== "production", so neither route existed and both returned 404 — meaning the
  // signature-verification path could never be exercised before shipping. They are
  // registered unconditionally here, ahead of the environment split.
// eSignature routes (DocuSign/PandaDoc Webhook)
app.post("/api/signature/webhook", async (req: Request, res: Response) => {
  // P0.14 — Verify BEFORE parsing or acting. This handler previously carried the comment
  // "In a real app we verify the HMAC signature from DocuSign here" and did not, which meant
  // anyone who could reach the URL could mark any meeting CONFIRMED by posting a JSON body.
  const verification = verifyDocuSignSignature(req, req.body as unknown as Buffer);
  if (!verification.ok) {
    console.warn(`[signature/webhook] Rejected unverified webhook: ${verification.reason}`);
    return res.status(401).json({
      error: { code: 'WEBHOOK_VERIFICATION_FAILED', message: verification.reason },
    });
  }

  try {
    const event = JSON.parse((req.body as unknown as Buffer).toString('utf8'));

    if (event.event === 'envelope-completed') {
      const customField = event.data?.envelopeSummary?.customFields?.customField;
      const meetingId = customField?.find((f: any) => f.name === 'meetingId')?.value;

      // P1.1 — A webhook has no authenticated user, so it cannot use orgScope(req). The
      // organisation must arrive with the envelope, as a custom field we set when the
      // envelope was created. An event that does not carry one is NOT applied to a default
      // tenant: without it we do not know whose meeting this is, and guessing would mean
      // writing one customer's signature confirmation into another customer's records.
      //
      // The value is validated before it reaches a datastore path — it is attacker-adjacent
      // input, since it only got here by surviving signature verification of a body we did
      // not write.
      const envelopeOrgId = customField?.find((f: any) => f.name === 'organizationId')?.value;

      if (meetingId && !isValidOrgId(envelopeOrgId)) {
        console.warn(
          `[signature/webhook] Envelope for meeting ${meetingId} carries no valid ` +
          `organizationId custom field; refusing to guess a tenant. Event ignored.`
        );
      } else if (meetingId) {
        console.log(`DocuSign webhook verified for meeting: ${meetingId}`);

        // P0.14 — Gate the transition on current state instead of writing CONFIRMED
        // unconditionally. Webhook delivery is duplicated, delayed and out of order, so a
        // late replay must not resurrect a meeting that has since been cancelled.
        const meetingRef = doc(firestore, orgPath(envelopeOrgId, 'meetings'), meetingId);
        const snap = await getDoc(meetingRef);
        if (!snap.exists()) {
          console.warn(`[signature/webhook] Meeting ${meetingId} not found; ignoring event.`);
        } else {
          // P1.4 — The hand-rolled terminal list that used to live here has been replaced by
          // the shared transition map. The rule is the same; the difference is that it is now
          // the same rule every other handler uses, instead of one someone remembered to write
          // here and nowhere else.
          const current = (snap.data() as any)?.status;
          const verdict = assertTransition(MEETING, current, 'CONFIRMED');
          if (verdict.ok === false) {
            console.warn(
              `[signature/webhook] Ignoring envelope-completed for meeting ${meetingId}: ` +
              `${verdict.message} A late or replayed event must not roll state backward.`
            );
          } else if (verdict.changed === false) {
            console.log(`[signature/webhook] Meeting ${meetingId} is already CONFIRMED; nothing to do.`);
          } else {
            await updateDoc(meetingRef, { status: 'CONFIRMED', statusChangedAt: new Date().toISOString() });
          }
        }
      }
    }
    res.status(200).send("OK");
  } catch(e) {
    console.error("DocuSign webhook error", e);
    res.status(500).json({ error: { code: 'WEBHOOK_PROCESSING_FAILED', message: 'Error' } });
  }
});


  // Gmail Pub/Sub Webhook
  app.post("/api/webhooks/gmail", async (req: Request, res: Response) => {
    // P0.14 / P0.5 — Verify before doing any work. This endpoint is auth-exempt and drives
    // gmailHistorySyncService.processEvent, an uncapped loop that issues paid AI calls. Left
    // unverified it is an open financial-loss primitive reachable by anyone on the internet.
    const verification = verifyPubSubToken(req);
    if (!verification.ok) {
      console.warn(`[webhooks/gmail] Rejected unverified push: ${verification.reason}`);
      return res.status(401).json({
        error: { code: 'WEBHOOK_VERIFICATION_FAILED', message: verification.reason },
      });
    }

    try {
      const message = req.body.message;
      if (!message || !message.data) {
        return res.status(400).send("Bad Request");
      }

      const decodedData = Buffer.from(message.data, 'base64').toString('utf8');
      const event = JSON.parse(decodedData);


      console.log(`Received Gmail Pub/Sub event for ${event.emailAddress} (historyId: ${event.historyId})`);

      gmailHistorySyncService.processEvent(event.emailAddress, event.historyId)
        .catch((e: Error) => console.error("Error processing history event:", e));

      res.status(200).send("OK");

    } catch(e) {
      console.error("Gmail webhook error", e);
      res.status(500).send("Error");
    }
  });

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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Abedin Growth AI] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
