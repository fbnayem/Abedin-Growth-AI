// P0.2 — MUST BE THE FIRST IMPORT. This module calls dotenv.config() at evaluation time.
// ES module imports are hoisted and evaluated in source order before this file's own
// statements run, so the `dotenv.config()` call further down was too late for any module
// that read process.env while being imported — notably the ActionGateway's Safe Mode flags.
// Keeping this first guarantees .env is loaded before any other module body executes.
import { safeModeSnapshot, isFullySafeMode } from './server/config/safeMode';
import { getCircuitBreakerState, setCircuitBreaker } from './server/services/circuitBreaker.service';
import { isFabricatedProviderId, actionGateway, ActionType } from './server/gateway/actionGateway';
import { verifyDocuSignSignature, verifyPubSubToken } from './server/services/webhookVerification.service';
import { standardApiLimiter, aiOperationLimiter, webhookLimiter } from './server/middleware/rateLimit';
import { collection, getDocs, getDoc, addDoc, doc, setDoc, updateDoc, query, where, orderBy, limit } from './server/store';
import { globalStore } from "./server/dataStore";
import { store } from "./server/store";
import { requireAuth } from "./server/middleware/auth";
import { securityHeaders } from "./server/middleware/securityHeaders";
import { schemaCompatibility } from "./server/build/schemaCompatibility";
import { healthResponse } from "./server/build/health";
import { resolveTenant } from "./server/middleware/tenant";
import { orgScope, orgPath, isValidOrgId } from "./server/tenancy/orgScope";
import { assertTransition, CAMPAIGN, MEETING, OPPORTUNITY } from "./server/domain/stateMachines";
import {
  createContactSchema,
  createKnowledgeItemSchema,
  createOpportunitySchema,
  parseOrRespond,
} from "./server/lib/validation";
import { normalizeEmailKey } from "./server/lib/emailKey";
import { createContactIfAbsent, ensureAccount, mergeContacts } from "./server/lib/identityStore";
import { accountDomain, contactDocId, plusAddressTag, suggestedBaseAddress } from "./server/lib/identity";
import { requestId, sendCaught, sendError, terminalErrorHandler } from "./server/lib/errors";
import {
  parseInstant,
  timeZoneRejection,
  isWithinBusinessHours,
  DEFAULT_BUSINESS_HOURS,
  toIsoOrNull,
} from './shared/domain/time';
import { normalizeScopes } from './server/lib/capabilities';
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
import { autonomyRouter } from "./server/routes/autonomy.routes";
import { unsubscribeRouter } from "./server/routes/unsubscribe.routes";
import { isUnauthenticatedApiPath } from "./server/middleware/authAllowlist";
import { cspReportRouter } from "./server/routes/cspReport.routes";
import { CSP_REPORT_PATH } from "./server/middleware/securityHeaders";
import { resolvePort } from "./server/config/port";

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
import { resolveProvenance, describeProvenance } from "./server/build/provenance";
import { BODY_SCHEMAS, type ContractBody, validateContractBody, type ContractRoute } from "./server/domain/apiContracts";
import { Lead, Investor, Partner, Campaign, Meeting, Opportunity, KnowledgeItem, EmailMessage, CompanyBrain } from "./src/types";

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
  app.use("/api/unsubscribe", unsubscribeRouter);
  app.use(CSP_REPORT_PATH, cspReportRouter);


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
        databaseConnectivity: !!store,
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
app.get("/api/health", async (req: Request, res: Response) => {
    // S49 — this used to answer `{ status: "ok", service: "..." }`, which is the same string in
    // every build that has ever run. S49's worst case turns on that: an operator reaching for
    // the kill switch cannot say which build is live or what to roll back to, and the service
    // name does not help them. `source` is reported beside the SHA because an injected SHA
    // identifies a released artifact and one read from a working tree does not — treating them
    // the same is how a wrong answer becomes worse than no answer.
    // S48 — the verdict now depends on the fact reported beside it.
    //
    // This reported `expectsMigration` and then answered "ok" whether or not that migration had
    // been applied. A health endpoint that prints the evidence and ignores it is worse than one
    // that prints neither: it looks like the check was made.
    const answer = healthResponse(resolveProvenance(), await schemaCompatibility());
    res.status(answer.status).json(answer.body);
  });

  // 1. Dashboard summary

  app.get("/api/leads", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(store, orgPath(orgScope(req), 'contacts')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      // filter for leads
      res.json(items.filter(i => i.type === 'LEAD' || !i.type));
    } catch(e: any) { sendCaught(req, res, e); }
  });

  /**
   * P1.10 — Build a contact from validated input.
   *
   * The three contact endpoints (leads, investors, partners) each did
   * `{ ...req.body, id, type, status }`, so any field a caller sent was persisted. The one
   * that matters is `consentGiven`: the action gateway reads it to decide whether a contact
   * may be emailed, so spreading the body let a caller create a contact that was already
   * consented to receive mail. `suppressed`, `organizationId` and `aiScore` were equally
   * writable.
   *
   * Consent is not an input. It records something that happened in the world, and a request
   * that creates a contact cannot also be evidence that the contact agreed to be contacted
   * (§14). New contacts are created with consent explicitly ABSENT, which the gateway reads as
   * "no consent record" and refuses to send to.
   */
  function buildContactDocument(
    input: import("./server/lib/validation").CreateContactInput,
    idPrefix: string,
    type: 'LEAD' | 'INVESTOR' | 'PARTNER',
    status: string
  ) {
    const emailKey = normalizeEmailKey(input.email);
    return {
      id: `${idPrefix}_${Date.now()}`,
      type,
      status,
      // Server-controlled. Never taken from the request.
      version: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Caller-supplied, but only these fields, and only after parsing.
      name: input.name ?? [input.firstName, input.lastName].filter(Boolean).join(' ') ?? '',
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      email: input.email,
      emailKey,
      title: input.title ?? null,
      phone: input.phone ?? null,
      linkedinUrl: input.linkedinUrl ?? null,
      companyName: input.companyName ?? null,
      companyWebsite: input.companyWebsite ?? null,
      industry: input.industry ?? null,
      country: input.country ?? null,
      employeeCount: input.employeeCount ?? null,
      notes: input.notes ?? null,
    };
  }

  /**
   * P1.5 — Creating a contact, once, for all three types.
   *
   * Each of these was its own `addDoc`, which asks Firestore for a fresh RANDOM id. Posting
   * the same person twice produced two documents and nothing noticed. That is not untidiness:
   * ActionGateway decides whether someone may be emailed by loading ONE contact document and
   * reading its suppression flags, so an unsubscribe recorded on document A left the person
   * mailable through document B.
   *
   * The id is now derived from the normalised address, so the same person is the same
   * document, and the create is a transaction that REFUSES when the document exists. Refusing
   * rather than overwriting is the point — an overwrite would reset `suppressed` and
   * `consentGiven`, turning the create endpoint into a way to clear an unsubscribe.
   */
  async function createContact(
    req: Request,
    res: Response,
    idPrefix: string,
    type: 'LEAD' | 'INVESTOR' | 'PARTNER',
    status: string
  ) {
    const input = parseOrRespond(createContactSchema, req, res);
    if (input === null) return;

    const orgId = orgScope(req);
    const outcome = await createContactIfAbsent(orgId, input.email, (id) => ({
      ...buildContactDocument(input, idPrefix, type, status),
      id,
      organizationId: orgId,
    }));

    if (outcome.ok === false) {
      if (outcome.code === 'ALREADY_EXISTS') {
        return sendError(
          req,
          res,
          'CONTACT_EXISTS',
          'A contact with this email address already exists in this organisation.',
          {
            details: {
              contactId: outcome.id,
              // Returned so a caller can decide between updating the existing record and
              // merging. Not acted on automatically: a re-post is not evidence of anything.
              existingStatus: outcome.existing.status ?? null,
              existingType: outcome.existing.type ?? null,
            },
          }
        );
      }
      if (outcome.code === 'UNUSABLE_EMAIL') {
        return sendError(req, res, 'VALIDATION_ERROR', outcome.message);
      }
      return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
    }

    // The account record for the contact's company domain. `accounts` was declared in the
    // schema and written by nothing, so every contact's accountId has always been null and the
    // resolver's DOMAIN_MATCH branch has always returned an undefined account.
    //
    // Failure here does not fail the request: the contact exists and is correct, and an
    // account is a grouping convenience. It is logged rather than swallowed.
    try {
      const account = await ensureAccount(orgId, input.email, {
        name: input.companyName ?? accountDomain(input.email),
        website: input.companyWebsite ?? null,
        industry: input.industry ?? null,
      });
      if (account.ok && account.created) {
        console.log(`[contacts] Created account ${account.id} for ${accountDomain(input.email)}`);
      }
    } catch (e: any) {
      console.error('[contacts] Account creation failed (contact was still created):', e?.message);
    }

    // A plus-tag is reported, never merged on. See lib/identity: a missed merge leaves a
    // visible duplicate, a wrong merge writes one person's history onto another's.
    const tag = plusAddressTag(input.email);
    const body: Record<string, unknown> = { ...outcome.data };
    if (tag !== null) {
      body.possibleDuplicateOf = suggestedBaseAddress(input.email);
      body.possibleDuplicateReason = `Address carries the tag "${tag}"; a human should confirm.`;
    }

    res.status(201).json(body);
  }

  app.post("/api/leads", async (req: Request, res: Response) => {
    try {
      await createContact(req, res, 'lead', 'LEAD', 'NEW');
    } catch(e: any) { sendCaught(req, res, e); }
  });

  /**
   * P1.5 — Merge one contact into another (§15, §14).
   *
   * Deterministic ids stop NEW duplicates. They do nothing about the ones seven addDoc call
   * sites have been creating for the life of the app, so the merge is the other half.
   *
   * Two things about this endpoint are deliberate. It names the survivor and the duplicate
   * explicitly rather than guessing which record to keep — that is a judgement about whose
   * history is authoritative, and it belongs to a person. And it is idempotent by resume
   * rather than by pretending: re-running reparents rows created since the last attempt,
   * because a Firestore transaction cannot enumerate them itself.
   */
  app.post("/api/contacts/:survivorId/merge", async (req: Request, res: Response) => {
    try {
      const survivorId = req.params.survivorId;
      const duplicateId = typeof req.body?.duplicateId === 'string' ? req.body.duplicateId : null;

      if (!duplicateId) {
        return sendError(
          req,
          res,
          'VALIDATION_ERROR',
          'A merge names both records: pass duplicateId in the body.'
        );
      }

      const outcome = await mergeContacts(orgScope(req), survivorId, duplicateId, {
        mergedBy: req.tenant?.uid,
        resume: req.body?.resume === true,
      });

      if (outcome.ok === false) {
        if (outcome.code === 'NOT_FOUND') {
          return sendError(req, res, 'NOT_FOUND', outcome.message);
        }
        if (outcome.code === 'STORE_UNAVAILABLE') {
          return sendError(req, res, 'STORE_UNAVAILABLE', outcome.message);
        }
        if (outcome.code === 'TOO_MANY_REFERENCES') {
          return sendError(req, res, 'TOO_MANY_REFERENCES', outcome.message, {
            details: { found: outcome.found },
          });
        }
        return sendError(req, res, 'MERGE_REFUSED', outcome.message, {
          details: { refusal: outcome.code },
        });
      }

      // The caller is told what the merge did to the permission state, because that is the
      // part with consequences: a survivor that has just inherited an unsubscribe is no longer
      // mailable, and an operator who merged two records to "tidy up" needs to know that.
      res.json({
        survivorId: outcome.survivorId,
        duplicateId: outcome.duplicateId,
        reparented: outcome.reparented,
        inheritedSuppression: outcome.inheritedSuppression,
        consentRevoked: outcome.consentRevoked,
      });
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.get("/api/inbox", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(store, orgPath(orgScope(req), 'conversations')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
  });


  app.post("/api/knowledge", async (req: Request, res: Response) => {
    try {
      const input = parseOrRespond(createKnowledgeItemSchema, req, res);
      if (input === null) return;

      // P1.4 — Knowledge is stringified into outbound prompts, so it enters the approval
      // lifecycle as DRAFT rather than as immediately usable text. Nothing may compose from it
      // until it is APPROVED (see KNOWLEDGE_ITEM in server/domain/stateMachines.ts).
      const payload = {
        id: `kno_${Date.now()}`,
        version: 0,
        status: 'DRAFT',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: input.title,
        content: input.content,
        category: input.category ?? null,
        tags: input.tags ?? [],
      };
      await addDoc(collection(store, orgPath(orgScope(req), 'knowledge')), payload);
      res.json(payload);
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.get("/api/knowledge", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(store, orgPath(orgScope(req), 'knowledge')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.get("/api/logs", async (req: Request, res: Response) => {
    try {
      // This ordered by `timestamp`. The only AIRunLog shape in the repository uses
      // `createdAt` and has no `timestamp` field at all — and Firestore EXCLUDES documents
      // that lack the ordered field, so this route would have returned [] even after a writer
      // was added, silently, with HTTP 200. An empty observability surface reading as "no
      // problems" is the §14 failure applied to logs.
      //
      // `writerExists` is true since server/lib/runLog.ts landed: the inbound pipeline writes
      // one row per run, on every exit path including the failures. An empty list now means
      // no run has happened, which is a different fact from "nothing records them" — and
      // saying which is the whole reason this field is here rather than a bare array.
      const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'ai_run_logs')), orderBy('createdAt', 'desc'), limit(50)));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json({
        items,
        writerExists: true,
        note:
          items.length === 0
            ? 'No runs have been recorded for this organisation yet. The inbound pipeline writes ' +
              'one row per run, so an empty list here means no message has been processed — not ' +
              'that runs go unrecorded.'
            : null,
      });
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.get("/api/pipeline", async (req: Request, res: Response) => {
    try {
      // P1.3 — See /api/campaigns: the version travels with every row.
      const snap = await getDocs(collection(store, orgPath(orgScope(req), 'opportunities')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
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
    const ref = doc(store, orgPath(orgScope(req), collectionName), 'main');
    const snap = await getDoc(ref);
    const data: any = snap.exists() ? snap.data() : {};
    const version = versionOf(data, snap.exists());
    res.setHeader('ETag', `"${version}"`);
    return res.json({ ...data, version });
  }

  /**
   * S11 — validate a body against the route's contract, or answer VALIDATION_ERROR.
   *
   * Returns the PARSED value. A handler that validates and then persists `req.body` has
   * validated nothing: the check passes and the unvalidated bytes are what get written.
   *
   * Returns null when it has already answered, so the caller returns without a second response.
   */
  function parsedBodyOr400<R extends ContractRoute>(
    req: Request,
    res: Response,
    route: R
  ): ContractBody<R> | null {
    const outcome = validateContractBody(route, req.body ?? {});
    if (outcome.ok === false) {
      sendError(
        req,
        res,
        'VALIDATION_ERROR',
        `${route} rejected ${outcome.problems.length} field(s): ${outcome.problems.join('; ')}`
      );
      return null;
    }
    return outcome.value;
  }

  async function writeSingleton(
    req: Request,
    res: Response,
    collectionName: string,
    payload: Record<string, unknown>
  ) {
    const ref = doc(store, orgPath(orgScope(req), collectionName), 'main');
    const expected = expectedVersionFrom(req);

    if (expected.ok === false) {
      // Tell the caller the current version in the same response that refuses the write, so
      // recovering from the error is one retry rather than a second round trip.
      const snap = await getDoc(ref);
      return sendVersionRequired(req, res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
    }

    // `version` and `expectedVersion` are transport, not content: they must not be persisted
    // as document fields, or the next read would hand them back as data.
    const { expectedVersion: _ignored, version: _alsoIgnored, ...body } = payload as any;

    const outcome = await mutateWithVersion(ref, expected.value, () => body);
    return sendMutationOutcome(req, res, outcome);
  }

  app.get("/api/company-brain", async (req: Request, res: Response) => {
    try {
      return await readSingleton(req, res, 'company_brain');
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.post("/api/company-brain", async (req: Request, res: Response) => {
    try {
      // S11 — this took `req.body` whole. The company brain is stringified into EVERY outbound
      // prompt, so a key written here is a key the model reads as part of its instructions —
      // the injection channel §18 describes, arriving as an ordinary API call rather than
      // through a retrieved document. The schema is strict, so an unexpected field is refused
      // rather than dropped: a caller that sent something it believed would be saved is told it
      // was not.
      const body = parsedBodyOr400(req, res, 'POST /api/company-brain');
      if (body === null) return;
      return await writeSingleton(req, res, 'company_brain', body);
    } catch(e: any) { sendCaught(req, res, e); }
  });


  app.get("/api/settings", async (req: Request, res: Response) => {
    try {
      return await readSingleton(req, res, 'settings');
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.post("/api/settings", async (req: Request, res: Response) => {
    try {
      // The autonomy gate is deliberately absent from this schema and cannot be set here: it
      // lives in the environment so that a datastore write can pause the system and can never
      // start it (P0.3).
      const body = parsedBodyOr400(req, res, 'POST /api/settings');
      if (body === null) return;
      return await writeSingleton(req, res, 'settings', body);
    } catch(e: any) { sendCaught(req, res, e); }
  });


  app.post("/api/pitch-battle/simulate", async (req: Request, res: Response) => {
    try {
      const result = await simulatePitchBattle(req.body);
      res.json(result);
    } catch(e: any) { sendCaught(req, res, e); }
  });


  app.post("/api/company-brain/generate", async (req: Request, res: Response) => {
    try {
      // P1.3 — Regeneration replaced the company brain blind, which is the most damaging
      // instance of the lost update in this file: the brain is stringified into every outbound
      // prompt, so silently discarding an operator's edit changes what customers are told.
      const ref = doc(store, orgPath(orgScope(req), 'company_brain'), 'main');
      const expected = expectedVersionFrom(req);
      if (expected.ok === false) {
        const snap = await getDoc(ref);
        return sendVersionRequired(req, res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
      }

      // Generated BEFORE the transaction: it is an external model call, and produceNext runs
      // inside a transaction that may be retried. A retryable block must not make paid calls.
      // S11 — validated against the registry, like its sibling. This passed `req.body` straight
      // to the agent, which interpolates every field into the prompt.
      const input = parsedBodyOr400(req, res, 'POST /api/company-brain/generate');
      if (input === null) return;

      const generated = await generateCompanyBrain(input);
      if (generated.ok === false) {
        // Nothing is written. An abstention used to be a hand-written template stored as though a
        // model had produced it, and an off-contract answer used to be stored whole.
        return sendError(
          req,
          res,
          generated.code === 'MODEL_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'MODEL_OUTPUT_INVALID',
          generated.reason
        );
      }

      const brain: Record<string, unknown> = { ...generated.brain };
      const outcome = await mutateWithVersion(ref, expected.value, () => brain);
      return sendMutationOutcome(req, res, outcome);
    } catch(e: any) { sendCaught(req, res, e); }
  });


  app.post("/api/leads/batch-generate", async (req: Request, res: Response) => {
    // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
    // collection: "Generated Lead 1" at lead0@example.com, with a random
    // aiScore between 70 and 89 so the result looked like research had happened. The UI
    // presents it as "Discover leads", so an operator had no way to tell the rows apart
    // from real ones.
    //
    // It is refused rather than left in place for two reasons. Fabricated records in the
    // CRM are a correctness problem on their own — they are indistinguishable from
    // researched contacts once written. And they entered through `addDoc`, which bypasses
    // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
    // duplicates that work exists to make unrepresentable.
    //
    // 501 is the honest answer: the feature is not implemented. A stub that returns
    // plausible data does not tell anyone that.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      'Discovery is not implemented. This endpoint previously returned fabricated ' +
        'leads written into the live contact list; it no longer writes anything. ' +
        'Add contacts through POST /api/leads, or connect a real discovery provider.'
    );
  });

  app.post("/api/investors/batch-generate", async (req: Request, res: Response) => {
    // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
    // collection: "Generated Investor 1" at investor0@example.com, with a random
    // aiScore between 70 and 89 so the result looked like research had happened. The UI
    // presents it as "Discover investors", so an operator had no way to tell the rows apart
    // from real ones.
    //
    // It is refused rather than left in place for two reasons. Fabricated records in the
    // CRM are a correctness problem on their own — they are indistinguishable from
    // researched contacts once written. And they entered through `addDoc`, which bypasses
    // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
    // duplicates that work exists to make unrepresentable.
    //
    // 501 is the honest answer: the feature is not implemented. A stub that returns
    // plausible data does not tell anyone that.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      'Discovery is not implemented. This endpoint previously returned fabricated ' +
        'investors written into the live contact list; it no longer writes anything. ' +
        'Add contacts through POST /api/investors, or connect a real discovery provider.'
    );
  });

  app.post("/api/partners/batch-generate", async (req: Request, res: Response) => {
    // P1.13 / P1.5 — This handler fabricated contacts and wrote them to the live
    // collection: "Generated Partner 1" at partner0@example.com, with a random
    // aiScore between 70 and 89 so the result looked like research had happened. The UI
    // presents it as "Discover partners", so an operator had no way to tell the rows apart
    // from real ones.
    //
    // It is refused rather than left in place for two reasons. Fabricated records in the
    // CRM are a correctness problem on their own — they are indistinguishable from
    // researched contacts once written. And they entered through `addDoc`, which bypasses
    // the derived id P1.5 relies on, so every call reintroduced exactly the un-keyed
    // duplicates that work exists to make unrepresentable.
    //
    // 501 is the honest answer: the feature is not implemented. A stub that returns
    // plausible data does not tell anyone that.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      'Discovery is not implemented. This endpoint previously returned fabricated ' +
        'partners written into the live contact list; it no longer writes anything. ' +
        'Add contacts through POST /api/partners, or connect a real discovery provider.'
    );
  });


  app.get("/api/campaigns", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(collection(store, orgPath(orgScope(req), 'campaigns')));
      const items: any[] = [];
      // P1.3 — The version travels with every row. A client cannot state the version it is
      // updating unless the read gives it one, so omitting this would make the write path
      // impossible to use correctly rather than merely easy to use incorrectly.
      snap.forEach((d: any) => items.push({ ...d.data(), version: versionOf(d.data(), true) }));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
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
      const docRef = doc(store, orgPath(orgScope(req), 'campaigns'), req.params.id);
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        return sendError(req, res, 'NOT_FOUND', 'No such campaign.');
      }

      const current: any = snap.data();
      const currentVersion = versionOf(current, true);

      // P1.4 — The legal set and the legal MOVES both come from the one transition map, so an
      // ARCHIVED campaign cannot be reactivated and a COMPLETED one cannot be paused. Neither
      // rule was expressible when this was a toggle.
      const verdict = assertTransition(CAMPAIGN, current.status, desired);
      if (verdict.ok === false) {
        return sendError(req, res, verdict.code, verdict.message, { status: 422 });
      }
      if (verdict.changed === false) {
        res.setHeader('ETag', `"${currentVersion}"`);
        return res.json({ ...current, version: currentVersion });
      }

      const expected = expectedVersionFrom(req);
      if (expected.ok === false) return sendVersionRequired(req, res, expected, currentVersion);

      const outcome = await mutateWithVersion(docRef, expected.value, (existing: any) => ({
        ...existing,
        status: desired,
        statusChangedAt: new Date().toISOString(),
      }));
      return sendMutationOutcome(req, res, outcome);
    } catch(e: any) { sendCaught(req, res, e); }
  };

  // Both spellings: /status is what it does, /toggle is what existing callers send.
  app.post("/api/campaigns/:id/status", setCampaignStatus);
  app.post("/api/campaigns/:id/toggle", setCampaignStatus);

  app.post("/api/settings/token", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to store an API token and stored nothing, so an operator who rotated
    // a credential had no way to discover the old one was still in use.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to store an API token and stored nothing, so an operator who rotated a credential had no way to discover the old one was still in use."
    );
  });
  app.post("/api/autopilot/run-cycle-now", (req: Request, res: Response) => res.json({ status: "success" }));
  app.post("/api/leads/research", (req: Request, res: Response) => res.json({ notes: "Research complete: High intent detected." }));
  app.post("/api/inbox/:id/reply", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // Replying to a customer is an external send. It must go through the Production
    // Action Gateway, which enforces consent, suppression and Safe Rebuild Mode; this
    // endpoint bypassed all of it and reported success without sending anything.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "Replying to a customer is an external send. It must go through the Production Action Gateway, which enforces consent, suppression and Safe Rebuild Mode; this endpoint bypassed all of it and reported success without sending anything."
    );
  });
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
      const docRef = doc(store, orgPath(orgScope(req), 'opportunities'), req.params.id);

      // The path is tenant-scoped, so an id belonging to another organisation resolves to
      // nothing. 404, not 403: saying "forbidden" would confirm the id exists in some other
      // tenant.
      const snap = await getDoc(docRef);
      if (!snap.exists()) {
        return sendError(req, res, 'NOT_FOUND', 'No such opportunity.');
      }

      const current: any = snap.data();
      const currentVersion = versionOf(current, true);
      const desired = (req.body || {}).stage;

      const verdict = assertTransition(OPPORTUNITY, current.stage, desired);
      if (verdict.ok === false) {
        // 422, not 400: the request is well-formed, it is the state change that is not
        // permitted. A client can tell "you sent nonsense" from "you may not do that".
        return sendError(req, res, verdict.code, verdict.message, { status: 422 });
      }
      if (verdict.changed === false) {
        res.setHeader('ETag', `"${currentVersion}"`);
        return res.json({ ...current, version: currentVersion });
      }

      const expected = expectedVersionFrom(req);
      if (expected.ok === false) return sendVersionRequired(req, res, expected, currentVersion);

      const outcome = await mutateWithVersion(docRef, expected.value, (existing: any) => ({
        ...existing,
        stage: desired,
        stageChangedAt: new Date().toISOString(),
      }));
      return sendMutationOutcome(req, res, outcome);
    } catch(e: any) { sendCaught(req, res, e); }
  };

  app.put("/api/pipeline/:id/stage", setOpportunityStage);
  app.post("/api/pipeline/:id/stage", setOpportunityStage);

  app.post("/api/meetings/brief", (req: Request, res: Response) => res.json({ brief: "Meeting brief generated." }));
  app.post("/api/settings/autopilot", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to save autopilot settings and saved nothing. An operator who turned
    // autopilot off was told it had been turned off. Nothing currently reads these
    // settings either, so the control does not exist in any form — which is what this
    // now says.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to save autopilot settings and saved nothing. An operator who turned autopilot off was told it had been turned off. Nothing currently reads these settings either, so the control does not exist in any form — which is what this now says."
    );
  });
  app.post("/api/meetings/:id/sign-contract", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // Signature is an external action gated by REAL_SIGNATURE_ENABLED. This endpoint
    // reported a contract signed while doing nothing, which is the most consequential
    // false claim in this group.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "Signature is an external action gated by REAL_SIGNATURE_ENABLED. This endpoint reported a contract signed while doing nothing, which is the most consequential false claim in this group."
    );
  });
  // P0.15 — Was `res.json({ success: true })`. This is the endpoint the UI calls to take
  // payment, and it reported success without contacting any payment provider, creating any
  // record, or moving any state. An operator watching the screen would believe a customer had
  // paid. A stub that fabricates success for a FINANCIAL action is worse than a missing
  // endpoint, so it now refuses honestly. Real payments go through /api/stripe.
  app.post("/api/meetings/:id/process-payment", (req: Request, res: Response) =>
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      'Payment processing is not implemented on this endpoint. It previously returned ' +
        'success without taking payment. Use the Stripe checkout flow (/api/stripe/create-checkout-session).'
    )
  );
  app.post("/api/meetings/:id/send-recovery-email", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // A recovery email is an external send and must go through the Production Action
    // Gateway. This endpoint sent nothing and said it had.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "A recovery email is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
    );
  });
  app.post("/api/inbox/auto-reply-all", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true, count: 5 })`.
    //
    // This reported five replies sent. It sent none, and a bulk reply is exactly the
    // operation that must go through the Production Action Gateway one recipient at a
    // time so consent and suppression are checked for each.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This reported five replies sent. It sent none, and a bulk reply is exactly the operation that must go through the Production Action Gateway one recipient at a time so consent and suppression are checked for each."
    );
  });
  app.post("/api/leads/batch-followup", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true, count: 10 })`.
    //
    // This reported ten follow-ups sent. It sent none. A batch send must go through the
    // Production Action Gateway per recipient.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This reported ten follow-ups sent. It sent none. A batch send must go through the Production Action Gateway per recipient."
    );
  });
  app.post("/api/leads/:id/simulate-reply", (req: Request, res: Response) => res.json({ reply: "Simulated reply from lead." }));
  app.post("/api/linkedin/send-message", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // Sending a LinkedIn message is an external action gated by
    // REAL_LINKEDIN_SEND_ENABLED and the Production Action Gateway. This endpoint sent
    // nothing and said it had.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "Sending a LinkedIn message is an external action gated by REAL_LINKEDIN_SEND_ENABLED and the Production Action Gateway. This endpoint sent nothing and said it had."
    );
  });
  app.get("/api/sender-identity", (req: Request, res: Response) => res.json({ name: "AI Agent", email: "agent@example.com" }));
  app.post("/api/sender-identity", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to save the sender identity and saved nothing, so outbound mail
    // would not have used what the operator configured.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to save the sender identity and saved nothing, so outbound mail would not have used what the operator configured."
    );
  });
  app.get("/api/linkedin-config", (req: Request, res: Response) => res.json({ enabled: true }));
  app.post("/api/linkedin-config", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to save the LinkedIn configuration and saved nothing.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to save the LinkedIn configuration and saved nothing."
    );
  });
  app.get("/api/inbox/sales-decision-engine/inspect", (req: Request, res: Response) => res.json({ decision: "Proceed" }));
  // P0.3 — Was `res.json({ success: true })`: it mutated nothing and returned no
  // `circuitBreaker` field, so the console set its state to `undefined` and crashed on the
  // next render — during precisely the incident an operator would press it. Now backed by a
  // durable, fail-closed service. See server/services/circuitBreaker.service.ts.
  app.post("/api/inbox/circuit-breaker/toggle", async (req: Request, res: Response) => {
    try {
      const { enabled, reason } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return sendError(req, res, 'VALIDATION_ERROR', '`enabled` must be a boolean.');
      }
      // Actor attribution. requireAuth currently admits anonymous callers (fixed in P0.4), so
      // record what we actually know rather than inventing an operator identity.
      const actor = req.user?.email || req.user?.uid || 'unattributed';
      const { state, accepted, message } = await setCircuitBreaker(enabled, reason, actor);
      res.json({ success: accepted, message, circuitBreaker: state });
    } catch (e: any) {
      // The kill switch failing to record a decision is the failure mode P0.3 exists to
      // remove, so it is logged in full — but e.message is the datastore's text and stays
      // server-side.
      sendError(req, res, 'INTERNAL_ERROR', 'The kill switch decision could not be recorded.', {
        cause: e,
      });
    }
  });
  // P1.13 — `/api/inbox/deep-audit` is DELETED, not stubbed.
  //
  // It was `res.json({ audit: "Clean" })` — an unconditional clean verdict from a safety
  // audit that never ran. That is worse than an absent endpoint and worse than a failing
  // one: it is an actively misleading safety signal, and the whole point of such a signal
  // is that somebody trusts it.
  //
  // A 501 would be honest, but the addendum roadmap asks for deletion specifically here,
  // and it is right to: leaving the route registered invites someone to "finish" it later
  // by filling in the body, whereas its absence forces the audit to be designed.
  //
  // The console reads `data.auditReport`, which this endpoint never returned, so no audit
  // figure in the UI has ever come from here.
  app.post("/api/inbox/:id/auto-reply", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // An automatic reply is an external send and must go through the Production Action
    // Gateway. This endpoint sent nothing and said it had.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "An automatic reply is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
    );
  });
  app.post("/api/inbox/:id/memory/refresh", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to recompute conversation memory and recomputed nothing. Memory is
    // now derived and stored as attributed facts by the inbound pipeline (P1.6); a
    // manual refresh endpoint has not been wired to it.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to recompute conversation memory and recomputed nothing. Memory is now derived and stored as attributed facts by the inbound pipeline (P1.6); a manual refresh endpoint has not been wired to it."
    );
  });
  app.post("/api/inbox/:id/follow-up", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to generate a follow-up and generated nothing.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to generate a follow-up and generated nothing."
    );
  });
  app.post("/api/inbox/:id/generate-multi-agent-reply", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // This claimed to generate a multi-agent reply draft and generated nothing.
    //
    // A false success on a settings write is quieter and no less wrong: the operator
    // believes a value is in force that was never stored.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "This claimed to generate a multi-agent reply draft and generated nothing."
    );
  });
  app.post("/api/meetings/:id/send-reminder", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // A meeting reminder is an external send and must go through the Production Action
    // Gateway. This endpoint sent nothing and said it had.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "A meeting reminder is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
    );
  });
  app.post("/api/leads/:id/email", (req: Request, res: Response) => {
    // P1.13 — Was `res.json({ success: true })`.
    //
    // Emailing a lead is an external send and must go through the Production Action
    // Gateway. This endpoint sent nothing and said it had.
    //
    // A false success on an external action is the worst shape this defect takes: the
    // operator believes a customer received something, so nobody looks again.
    sendError(
      req,
      res,
      'NOT_IMPLEMENTED',
      "Emailing a lead is an external send and must go through the Production Action Gateway. This endpoint sent nothing and said it had."
    );
  });

  app.get("/api/dashboard", async (req: Request, res: Response) => {
    try {
      if (!store) return sendError(req, res, 'STORE_UNAVAILABLE', 'The datastore is not available.');
      const orgId = orgScope(req);

      const contactsSnap = await getDocs(collection(store, orgPath(orgId, 'contacts')));
      let qualifiedLeadsCount = 0;
      contactsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "QUALIFIED" || s === "ENGAGED" || s === "DEMO_SCHEDULED") qualifiedLeadsCount++;
      });

      const convsSnap = await getDocs(collection(store, orgPath(orgId, 'conversations')));
      let positiveConversationsCount = 0;
      convsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "ACTIVE" || s === "HUMAN_NEEDED" || s === "MEETING_REQUESTED") positiveConversationsCount++;
      });

      const meetingsSnap = await getDocs(collection(store, orgPath(orgId, 'meetings')));
      let meetingsBookedCount = 0;
      meetingsSnap.forEach(doc => {
         if (doc.data().status === "CONFIRMED") meetingsBookedCount++;
      });

      const oppsSnap = await getDocs(collection(store, orgPath(orgId, 'opportunities')));
      let pipelineValue = 0;
      oppsSnap.forEach(doc => {
          // `value` comes back from the store as `unknown` rather than the SDK's `any`.
          // Coerced explicitly: a non-numeric value used to be added straight into the total,
          // where `undefined` would have turned the whole pipeline figure into NaN.
          const value = Number(doc.data().value);
          pipelineValue += Number.isFinite(value) ? value : 0;
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
      sendCaught(req, res, e);
    }
  });


  app.get("/api/analytics/funnel", async (req: Request, res: Response) => {
    try {
      const allContactsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'contacts'))); const allContacts: any[] = []; allContactsSnap.forEach(d => allContacts.push(d.data()));
      const allConvsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'conversations'))); const allConvs: any[] = []; allConvsSnap.forEach(d => allConvs.push(d.data()));
      const allMeetingsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings'))); const allMeetings: any[] = []; allMeetingsSnap.forEach(d => allMeetings.push(d.data()));

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
      const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'contacts')), where('type', '==', 'INVESTOR')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.post("/api/investors", async (req: Request, res: Response) => {
    try {
      await createContact(req, res, 'inv', 'INVESTOR', 'DISCOVERED');
    } catch(e: any) { sendCaught(req, res, e); }
  });





  // 5. Partners

  app.get("/api/partners", async (req: Request, res: Response) => {
    try {
      const snap = await getDocs(query(collection(store, orgPath(orgScope(req), 'contacts')), where('type', '==', 'PARTNER')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.post("/api/partners", async (req: Request, res: Response) => {
    try {
      await createContact(req, res, 'part', 'PARTNER', 'DISCOVERED');
    } catch(e: any) { sendCaught(req, res, e); }
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
      return sendError(
        req,
        res,
        'PROVIDER_UNAVAILABLE',
        'A real Gmail access token is required. Refusing to store a placeholder credential, ' +
          'which would make the gateway report sends that never happened.',
        { status: 400 }
      );
    }

    // TODO(P1 — tenant resolution): org is hardcoded here as everywhere else in this file.
    // TODO(P0.0/P0.6 — credential storage): oauth_connections is a top-level collection in a
    // datastore whose rules are still `allow read, write: if true`, so this token is readable
    // and overwritable by anyone until the rules are closed and server access moves to the
    // Admin SDK. Storing a real credential here is only acceptable once that has landed.
    const orgId = orgScope(req);

    try {
      // P1.11 — the record now stores what the grant actually WAS.
      //
      // It previously held the token, the account and an expiry, and nothing about scopes or
      // refresh. Two consequences followed. Nothing could check before sending whether this
      // credential was ever permitted to send, so a `gmail.readonly` token reached the send
      // path and was refused by Google after dispatch. And with no refresh token the
      // connection died an hour later and stayed dead until a human reconnected.
      //
      // `scopes` is normalised to an array or to null. Null means "not recorded", which the
      // capability check treats as a refusal rather than as a blank cheque: an unrecorded
      // grant is not a grant (§14).
      const recordedScopes = normalizeScopes(req.body?.scope ?? req.body?.scopes);
      const record: Record<string, unknown> = {
        organizationId: orgId,
        provider: 'gmail',
        accessToken,
        refreshToken: typeof req.body?.refreshToken === 'string' && req.body.refreshToken.length > 0
          ? req.body.refreshToken
          : null,
        scopes: recordedScopes,
        accountEmail: accountEmail || null,
        // Expiry is derived server-side; an absent expiresIn means "unknown", not "forever".
        expiresAt: typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null,
        status: 'ACTIVE',
        updatedAt: new Date(),
      };

      if (recordedScopes === null) {
        console.warn(
          `[oauth] Gmail connection for ${orgId} stored WITHOUT scopes. Sends will be refused ` +
            `by the capability pre-flight until the account is reconnected with a scope list. ` +
            `This is deliberate: an unrecorded grant is not a grant.`
        );
      }

      const existing = await getDocs(query(collection(store, 'oauth_connections'), where('organizationId', '==', orgId), where('provider', '==', 'gmail')));
      if (!existing.empty) {
        await updateDoc(existing.docs[0].ref, record);
      } else {
        await addDoc(collection(store, 'oauth_connections'), { id: 'oauth_' + Date.now(), ...record });
      }
      res.json({ success: true });
    } catch(e) {
      console.error("Token sync error:", e);
      // e.message here is the provider's own text; it goes to the log, not to the caller.
      sendError(req, res, 'PROVIDER_UNAVAILABLE', 'The provider could not be reached.', { cause: e });
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
      sendCaught(req, res, error);
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
      sendCaught(req, res, error);
    }
  });

  // 12-Layer Sales Decision Engine Real-Time Inspection Endpoint (Part 36 Admin Debug View)



  // Conversation Memory Endpoints (allocated memory checking full thread)



  // 8. Pipeline Opportunities



  app.post("/api/campaigns/generate-strategy", async (req: Request, res: Response) => {
    try {
      const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount, isABTestingEnabled } = req.body;

      const projectedReach = enrolledCount || 0;

      // S27 — the 68% and 12% are gone.
      //
      // They were `Math.floor(projectedReach * 0.68)` and `* 0.12`, persisted onto the campaign
      // as `projectedMetrics` and rendered as a projection. Nothing measured them: this system
      // has never sent an autonomous email, there is no open pixel, no click redirect and no
      // bounce webhook, so there is no engagement history for any rate to have come from.
      //
      // The worst case in S27 is a founder scaling spend on `enrolledCount * 0.68` and
      // reporting it to an investor. A number with no source is worse than a blank, because a
      // blank prompts the question and a number answers it.

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
        // Reach is the enrolment count, which is a fact. Engagement and conversion are not
        // reported at all until something measures them.
        projectedMetrics: { reach: projectedReach, engagement: null, conversion: null, why: 'not measured: no open, click or bounce ingestion exists' },
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

      await addDoc(collection(store, orgPath(orgScope(req), 'campaigns')), newCampaign);
      res.json(newCampaign);
    } catch(e: any) { sendCaught(req, res, e); }
  });





  app.post("/api/pipeline", async (req: Request, res: Response) => {
    try {
      const input = parseOrRespond(createOpportunitySchema, req, res);
      if (input === null) return;

      // P1.4 — A new opportunity starts at an initial stage of the machine, not at whatever
      // the caller sent. A supplied stage is honoured only if it is a legal starting point.
      const requestedStage = input.stage;
      const stage =
        requestedStage && OPPORTUNITY.transitions[requestedStage] !== undefined
          ? requestedStage
          : OPPORTUNITY.initial[0];

      const payload = {
        id: `opp_${Date.now()}`,
        version: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        stage,
        // `value` was previously `req.body.estimatedValue || req.body.value || 0` with no type
        // check, so a string produced NaN downstream and rendered as "NaN".
        value: input.estimatedValue ?? input.value ?? 0,
        currency: input.currency ?? 'GBP',
        title: input.title ?? null,
        companyName: input.companyName ?? null,
        contactName: input.contactName ?? null,
        contactEmail: input.contactEmail ?? null,
        nextStep: input.nextStep ?? null,
        expectedCloseDate: input.expectedCloseDate ?? null,
      };
      await addDoc(collection(store, orgPath(orgScope(req), 'opportunities')), payload);
      res.json(payload);
    } catch(e: any) {
      console.error(e);
      sendCaught(req, res, e);
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
  // The request is validated and projected (it previously spread `...req.body` straight into
  // the document, a mass assignment), an overlap check runs against OUR OWN records, and —
  // as of 2026-09-07 — the booking is then dispatched through the ActionGateway as a real
  // CALENDAR_CREATE. That gives `dispatchAction` its SECOND call site in the repository and
  // gives §31 an enforcement point on the path that actually runs.
  //
  // The two refusals are not the same refusal, and the distinction is the whole point:
  //
  //   provider says BUSY / cannot say      -> NO local record either. Zero create requests,
  //                                           and we do not record a meeting we know clashes.
  //   provider unreachable / flag off      -> local record stands, PENDING_CALENDAR_SYNC.
  //                                           Our own meeting list is ours; the Google event
  //                                           is a sync, and an unsynced meeting is honest
  //                                           where a silently-unsynced one is not.
  app.post("/api/meetings", async (req: Request, res: Response) => {
    try {
      const { contactId, scheduledTime, timeZone, durationMinutes, title, notes } = req.body || {};

      // P1.9 — this was `new Date(scheduledTime).getTime()`, which reads an offset-less string
      // such as "2026-09-07T14:00" as the SERVER's local time. On this machine that is six
      // hours from the same string read as UTC, and the route accepted both spellings into one
      // field. `parseInstant` requires an offset, so a string can only mean one moment.
      let startInstant: Date;
      try {
        startInstant = parseInstant(scheduledTime);
      } catch (err: any) {
        return sendError(req, res, 'VALIDATION_ERROR', String(err?.message ?? '`scheduledTime` is not an instant.'));
      }
      const startMs = startInstant.getTime();

      // The zone is required, not defaulted. Defaulting it would be the server asserting what
      // the customer agreed to (§14): a meeting whose zone we guessed is a meeting we cannot
      // honestly restate, and the guess is invisible in the stored row.
      const zoneRejection = timeZoneRejection(timeZone);
      if (zoneRejection !== null) {
        return sendError(
          req,
          res,
          'VALIDATION_ERROR',
          `\`timeZone\` must be an IANA identifier. ${zoneRejection}`
        );
      }
      const duration = Number.isFinite(Number(durationMinutes)) ? Number(durationMinutes) : 30;
      if (duration <= 0 || duration > 480) {
        return sendError(req, res, 'VALIDATION_ERROR', '`durationMinutes` must be between 1 and 480.');
      }
      const endMs = startMs + duration * 60_000;

      // Conflict detection against existing non-cancelled meetings.
      const existingSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings')));
      const conflicts: any[] = [];
      existingSnap.forEach((d) => {
        const m: any = d.data();
        if (['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(m.status)) return;
        const stored = m.startAtUtc ?? m.scheduledTime;
        const mStart = stored?.toMillis?.() ?? new Date(stored || 0).getTime();
        if (!Number.isFinite(mStart) || mStart === 0) return;
        const mEnd = mStart + (Number(m.durationMinutes) || 30) * 60_000;
        // Half-open intervals: [start, end). Touching meetings do not conflict.
        if (mStart < endMs && startMs < mEnd) conflicts.push({ id: m.id, scheduledTime: m.scheduledTime });
      });

      if (conflicts.length > 0) {
        // The invariant: on a confirmed conflict, do NOT create. Zero provider requests, and
        // zero local records that would later be treated as a real booking.
        console.warn(`[meetings] Refused booking: ${conflicts.length} overlapping meeting(s).`);
        return sendError(
          req,
          res,
          'VERSION_CONFLICT',
          `Requested slot overlaps ${conflicts.length} existing meeting(s).`,
          { status: 409, details: { conflicts } }
        );
      }

      // Booking outside the operator's stated hours is refused rather than quietly accepted:
      // an 03:00 meeting is not a meeting, and the caller is told the local time it computed
      // so the disagreement is visible instead of arriving as a calendar invitation.
      const hoursVerdict = isWithinBusinessHours(startInstant, DEFAULT_BUSINESS_HOURS);
      if (hoursVerdict.within === false && req.body?.allowOutsideBusinessHours !== true) {
        return sendError(
          req,
          res,
          'VALIDATION_ERROR',
          `${hoursVerdict.localTime} is outside business hours (${hoursVerdict.reason}). ` +
            'Send `allowOutsideBusinessHours: true` to book it deliberately.'
        );
      }

      // P0.13/S31 — free/busy on the live path.
      //
      // The idempotency key is derived from the booking itself, so retrying the same request
      // asks Google for the SAME conference rather than minting a second Meet link for one
      // meeting (the old `requestId: "req_" + Date.now()` did exactly that).
      const idempotencyKey = [
        orgScope(req),
        contactId ?? "no-contact",
        String(startMs),
        String(duration),
      ].join(":");

      const dispatchResult = await actionGateway.dispatchAction({
        actionType: ActionType.CALENDAR_CREATE,
        organizationId: orgScope(req),
        targetId: contactId ?? "unknown",
        proposedBy: "POST /api/meetings",
        payload: {
          title: title ?? "Meeting",
          description: notes ?? undefined,
          startTime: startInstant.toISOString(),
          endTime: new Date(endMs).toISOString(),
          timezone: timeZone,
          attendees: [],
          idempotencyKey,
        },
      });

      // A conflict the PROVIDER reported, or an availability we could not read, refuses the
      // booking outright. §31 asks how many create requests are issued when free/busy says
      // busy; the gateway issues zero, and this keeps the local record consistent with that.
      if (dispatchResult.errorCode === 'CALENDAR_CONFLICT' || dispatchResult.errorCode === 'AVAILABILITY_UNKNOWN') {
        return sendError(
          req,
          res,
          'VERSION_CONFLICT',
          dispatchResult.blockedReason ?? dispatchResult.error ?? "The slot is not available.",
          { status: 409, details: { errorCode: dispatchResult.errorCode } }
        );
      }

      // Anything else that failed leaves the meeting recorded but explicitly unsynced. The
      // reason travels with the record so the operator sees WHY nothing was booked, rather
      // than a status that merely says PENDING forever.
      const providerEventId =
        dispatchResult.success === true ? dispatchResult.providerResult?.eventId ?? null : null;
      const meetUrl =
        dispatchResult.success === true ? dispatchResult.providerResult?.conferenceUrl ?? null : null;
      const providerSyncStatus =
        dispatchResult.success === true ? 'SYNCED' : 'PENDING_CALENDAR_SYNC';
      const providerSyncReason =
        dispatchResult.success === true
          ? null
          : dispatchResult.blockedReason ?? dispatchResult.error ?? "Calendar sync did not run.";

      const payload = {
        id: "meet_" + Date.now(),
        contactId: contactId ?? null,
        title: title ?? null,
        notes: notes ?? null,
        // Both halves. `startAtUtc` is the instant the calendar needs; `timeZone` is what the
        // customer agreed to, and it is the half that cannot be recovered later if dropped.
        startAtUtc: new Date(startMs),
        timeZone: timeZone,
        durationMinutes: duration,
        status: 'SCHEDULED',
        // Honest about provider state, and now able to say something other than "pending":
        // this reports what the dispatch actually returned rather than a constant.
        providerSyncStatus,
        providerEventId,
        providerSyncReason,
        meetUrl,
        createdAt: new Date(),
      };
      await addDoc(collection(store, orgPath(orgScope(req), 'meetings')), payload);
      res.json(payload);
    } catch(e: any) { sendCaught(req, res, e); }
  });

  app.get("/api/meetings", async (req: Request, res: Response) => {
    try {
      const dbMeetingsSnap = await getDocs(collection(store, orgPath(orgScope(req), 'meetings'))); const dbMeetings: any[] = []; dbMeetingsSnap.forEach(d => dbMeetings.push(d.data()));
      const mapped = dbMeetings.map(m => ({
        id: m.id,
        contactId: m.contactId,
        prospectName: "Unknown",
        prospectEmail: "unknown@example.com",
        companyName: "Unknown",
        status: m.status,
        // Found by a runtime probe, not by the compiler or the tests: the stored value comes
        // back from Firestore as a `Timestamp`, which has `toMillis()` and `toDate()` and NOT
        // `toISOString()`. The original line was `m.scheduledTime.toISOString()`, so this
        // endpoint has been answering `scheduledAt: undefined` for every meeting it has ever
        // returned — a 200 carrying a field that was never populated.
        scheduledAt: toIsoOrNull(m.startAtUtc ?? m.scheduledTime),
        timeZone: m.timeZone ?? null,
        durationMinutes: m.durationMinutes ?? null,
        meetLink: m.meetUrl,
      }));
      res.json(mapped);
    } catch(e) { console.error(e); sendCaught(req, res, e); }
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
      sendCaught(req, res, e);
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
    return sendError(req, res, 'WEBHOOK_VERIFICATION_FAILED', verification.reason);
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
        const meetingRef = doc(store, orgPath(envelopeOrgId, 'meetings'), meetingId);
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
    sendError(req, res, 'INTERNAL_ERROR', 'The webhook could not be processed.', { cause: e });
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
      return sendError(req, res, 'WEBHOOK_VERIFICATION_FAILED', verification.reason);
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
