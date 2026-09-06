# Active Code Graph

**Repository:** Abedin Growth AI
**Artifact mandated by:** Addendum S1
**Status of the system it describes:** pre-production. Several capabilities named below have no owner, or more than one.

---

## 1. Purpose and derivation

### Purpose

This document answers three questions that the repository itself cannot currently answer:

1. **What actually runs?** Which files are reachable from a running process, as opposed to merely present in the tree.
2. **Who owns each capability?** For every business capability (sending email, booking calendar, taking payment, suppressing a contact), which single module is authoritative — and where that answer is "none" or "several", it is stated as such.
3. **What is inert?** Which files read as production code, compile cleanly, and are executed by nothing.

The third question is the dangerous one. This repository contains a coherent, fully-wired **second implementation of the product** — `server/services/pipeline.service.ts` plus six collaborators — that a maintainer will reasonably mistake for the live path. Fixing a bug there ships nothing.

### Derivation method

The graph was computed by import-graph traversal from the two real entrypoints:

- **Backend:** `server.ts` (the process started by `npm run dev` / `npm start`)
- **Frontend:** `src/main.tsx` (the Vite client entry)

Traversal followed static `import` statements only, with a resolver honouring `.ts` / `.tsx` / `index.*` resolution, across **119 TypeScript files**. Result:

| Class | Count |
|---|---|
| Reachable from `server.ts` or `src/main.tsx` | 94 |
| Unreachable (dead) | 25 |
| Legitimate tool entrypoints (not dead, not app code) | 2 — `drizzle.config.ts`, `vite.config.ts` |

Reachability is a necessary but **not** sufficient condition for "live". Several reachable modules are imported and never invoked (`evaluatePolicy`, `auditReplyAgainstPlan`, `tripCircuitBreaker`, `PrivacyService`, `resolveClientIdentity`, `executeMultiAgentReplyPipeline`), and several reachable code paths sit behind an unconditional `NODE_ENV` branch or behind a throwing database proxy. Those are called out per-row below rather than folded into the counts.

**Caveat on line numbers.** Line citations in this document are accurate as of the commit at which it was written and will drift. Treat file and symbol names as authoritative; re-derive line numbers before relying on them.

---

## 2. Entrypoints and boot sequence

### Active backend entrypoint

`server.ts` — an 834-line monolith holding roughly 75 Express handler registrations. `npm run dev` runs `tsx server.ts`; `npm start` runs `node dist/server.cjs` (an esbuild bundle of the same file).

### Active frontend entrypoint

`src/main.tsx` — five lines: `createRoot(...).render(<StrictMode><App /></StrictMode>)`. All frontend surface hangs off `src/App.tsx`.

### Runtime boot sequence (`startServer()`)

| # | Step | Location | Note |
|---|---|---|---|
| 1 | Module-scope imports evaluated | `server.ts:1-50` | `server/dataStore.ts` self-initialises here: loads `server/data_storage.json` from disk, or seeds ~400 synthetic leads via `seedLeadsGenerator`. `server.ts` never reads `globalStore` afterwards. |
| 2 | `server/firebase.ts` initialises | via import | Uses the Firebase **client** SDK (`initializeClientApp` + `getFirestore`), gated only on `firebase-applet-config.json` existing on disk. No network I/O, so a "connected" Firestore handle proves nothing. Anonymous auth was removed because `firestore.rules` is fully open. |
| 3 | `server/db/index.ts` initialises | via import | `DATABASE_URL` is empty ⇒ `createPool()` returns `null` ⇒ `db` is a `Proxy` whose every property access **throws** `"Database is not configured…"`. |
| 4 | `dotenv.config()` | `server.ts:51` | Runs *after* the imports above, so any module reading `process.env` at import time sees the pre-`.env` environment. |
| 5 | `express.json()` mounted globally | `server.ts:58` | **Ordering defect.** This consumes the request stream and sets `req._body`, so the later route-level `express.raw({type:'application/json'})` on `/api/stripe/webhook` and `/api/signature/webhook` short-circuits. Both webhook signature paths are therefore non-functional. |
| 6 | `/api` auth gate mounted | `server.ts:60-67` | Bypasses `requireAuth` for any path where `req.path.includes('/webhook')` — a substring test, not a prefix or segment match. |
| 7 | `stripeRouter`, `outboxRouter` mounted | `server.ts:70-71` | The only two extracted routers, covering 5 endpoints. All three outbox routes hit the throwing Drizzle proxy. |
| 8 | ~70 inline handlers registered | `server.ts:75-753` | Includes a contiguous block of ~30 hardcoded success stubs at `server.ts:309-344`. |
| 9 | Dev **or** prod branch | `server.ts:760-823` | Dev: Vite middleware. Prod: static serving, **plus** `/api/signature/webhook`, `/api/webhooks/gmail` and the SPA catch-all. Those three routes **do not exist in development.** |
| 10 | `outboxWorker.start()` | `server.ts:825` | Unconditional. Starts a bare `setInterval(processQueue, 5000)`. No reachable code path stops it. |
| 11 | `app.listen(3000)` | `server.ts:827` | |

**Consequence of step 9:** the dev and prod route tables differ. The inbound-email path and the contract-signature path cannot be exercised locally at all — they appear for the first time in production.

---

## 3. Canonical owner table

This is the core of the document. "Canonical owner" means the single module through which all instances of this capability pass. Where that does not exist, the cell says so.

| Capability | Canonical owner | Competing / duplicate paths | Status |
|---|---|---|---|
| **Email sending** | `server/gateway/actionGateway.ts` → `executeEmailSend` (sole caller of `gmailService.sendEmail`), reached only from `server/workers/outbox.worker.ts` | (a) `server.ts:344` `/api/leads/:id/email` — hardcoded `{success:true}` stub; (b) `server.ts:328` `/api/inbox/auto-reply-all` — returns `{success:true,count:5}`; (c) `src/pages/InboxView.tsx` → `src/services/gmailWorkspaceService.ts` sends **from the browser**, bypassing the server, the gateway, policy, outbox and circuit breaker entirely | **CONTESTED — 4 paths.** The gateway is the intended owner and is bypassed by three others. Additionally the gateway fabricates success (`messageId: 'sim_email_…'`) whenever the stored token is the literal `'mock_token'` — which `server.ts` writes on every Gmail connect — so the gateway path currently simulates 100% of sends and the worker records them as `status:'SENT'`. |
| **Calendar mutation** | `server/gateway/actionGateway.ts` → `executeCalendarCreate` (real Google Calendar POST) | `server/services/calendar.service.ts` — a complete parallel implementation, **DEAD**, whose `checkFreeBusy()` is `return true` | **NO LIVE OWNER IN PRACTICE.** `ActionType.CALENDAR_CREATE` is never dispatched: the only `dispatchAction` call site always passes `EMAIL_SEND`. Meetings are actually created by `server.ts:669` (`addDoc` to Firestore, no provider call, no free/busy check) and by `multiAgentReplySystem` (writes `status:"CONFIRMED"` with `meetUrl: ".../pending-calendar-creation"`). The gateway also computes a free/busy conflict result and then never reads it. |
| **Payment execution** | **None.** | (a) `server/routes/stripe.routes.ts` — creates a real Stripe checkout session at `unit_amount: 500000` USD; (b) `ActionType.PAYMENT_CREATE` is declared in the gateway but falls through to `default: 'Unsupported action type'`; (c) `server.ts:326` `/api/meetings/:id/process-payment` — a `{success:true}` stub, and it is the one the UI calls | **NO OWNER — SPLIT 3 WAYS.** Payments bypass the gateway entirely: no audit log, no safe-mode flag, no ownership lock. The Stripe webhook handler logs to console and persists nothing, and its signature verification is defeated by the `express.json()` ordering defect, so it returns 400 for every genuine event. |
| **Campaign execution** | **None.** | `server.ts:593-644` generates campaign step text (`stepNumber`, `delayDays`) and writes it to Firestore. Nothing reads it — `delayDays` has exactly two readers repo-wide, both React render labels. | **NO OWNER.** Campaigns are authored and stored; there is no scheduler, no enrolment record, no per-contact sequence state, and no sender. The UI's "Bulk Enroll in Campaign" mutates local React state only and marks people `CONTACTED` without any server call. |
| **Reply orchestration** | **None.** | (a) `salesDecisionEngine.composeAutonomousSalesReply` — called by `inboundPipeline.ts` with a mismatched argument shape (`incomingEmail` where `rawInboundText`/`identity` are declared, via an `as any` cast), so it throws on first dereference; (b) `multiAgentReplySystem.executeMultiAgentReplyPipeline` — imported by `server.ts` and **never invoked** (its route is a stub); (c) `agents/replyComposer.agent.ts` — DEAD | **NO OWNER — 3 CANDIDATES, 0 WORKING.** One is unreachable, one is called with the wrong contract, one is dead code. |
| **Outbox processing** | **None.** | Producer: `services/inboundPipeline.ts` inserts into **Postgres** `outboxMessages`. Consumer: `workers/outbox.worker.ts` reads **Firestore** `organizations/org_1/outbox`. Review console: `routes/outbox.routes.ts` lists / approves / rejects in **Postgres**. The only Firestore producer, `outboxService.queueMessage`, has one caller — `services/pipeline.service.ts`, which is DEAD. | **NO OWNER — SPLIT ACROSS TWO DATASTORES, AND INERT.** The Firestore queue has no reachable producer, so `fetchPendingJobs` always returns `[]`. Approving a message writes to a store the worker never reads. `db` throws in dev, so all three review routes 500 and the worker marks every job `FAILED` before dispatch. There is no claim, lease, attempt counter, retry or dead-letter state anywhere. |
| **Authentication** | `server/middleware/auth.ts` — single owner | None | **SINGLE OWNER, BUT NOT AUTHENTICATION.** With no `Authorization` header the middleware assigns `req.user = { uid: "preview_uid" }` and calls `next()`. A hardcoded bearer `"demo_bary"` mints a session. If `firebaseAuth` failed to initialise, all tokens are accepted unverified. `req.user` is read exactly once in the entire server, and that value is then discarded in favour of a literal. |
| **Tenant resolution** | **None.** | The literal `'org_1'` appears 43 times across `server.ts`, `actionGateway.ts`, `outbox.service.ts`, `outbox.worker.ts`, `dataStore.ts` and `tests/pipeline.test.ts`. `outbox.worker.ts` carries `const orgId = "org_1"; // Defaulting for now based on migration`. `actionGateway` reads consent from `organizations/org_1/contacts` even though `request.organizationId` is in scope and is used correctly nine lines later. | **NO OWNER — DOES NOT EXIST.** There is no uid→organization lookup anywhere in `server/`. `identityResolver.service.ts` accepts an `organizationId` parameter and never references it again; its queries are global. 13 of 19 Drizzle tables have no organization column at all, so a tenant predicate is not even expressible on the tables holding messages, the send queue and pricing. |
| **Commercial truth (pricing)** | **None.** | `salesDecisionEngine` (`£499 / month per clinic location`); `multiAgentReplySystem` (prompt text plus `monthlyFee: category === "PARTNER" ? 1499 : 499`); `independentAuditor` (audits by substring-matching `'£499'`, and *penalises* replies that omit it); `policies/claimGrounding.ts` (the same substring check); `conversationMemoryAgent`; `src/components/LiveMeetingRoomModal.tsx`; `stripe.routes.ts` (`unit_amount: 500000` USD); `dataStore.ts` (`Starter £299` / `Growth £599`); `server/data_storage.json` (`Growth Tier (£499/mo)`) | **NO OWNER — 7+ FILES, 2 CURRENCIES, 3 CONTRADICTORY PRICES.** A price change requires editing seven files in two languages of truth. The same tier name carries two different prices in shipped data. The "grounding" check is a substring match, and the auditor actively scores *down* a reply that honours a negotiated price instead of list price. |
| **Suppression** | **None functioning.** | (a) `salesDecisionEngine.isSuppressed` — the live implementation, but it reads `globalStore.leads` / `globalStore.conversations` (the in-memory/JSON store) while every write goes to Firestore; its only caller is `independentAuditor`, which `inboundPipeline.ts` replaces with a hardcoded `{ decision: 'PASS' }`; (b) `services/suppression.service.ts` — DEAD, and backed by a process-global array with a fail-open `|| false` | **NO WORKING OWNER.** Neither the outbox worker nor the ActionGateway performs any suppression check before sending. There is no unsubscribe endpoint on the HTTP surface at all, so nothing can ever record a suppression. The one branch of `isSuppressed` that can fire is the hardcoded `no-reply` / `mailer-daemon` / `postmaster` pattern match. |

### Summary of the table

| Verdict | Capabilities |
|---|---|
| Single canonical owner, functioning | *(none)* |
| Single owner, but the owner does not do what its name implies | Authentication |
| Contested — multiple live paths | Email sending |
| No owner in practice | Calendar mutation, Reply orchestration, Suppression |
| No owner at all | Payment execution, Campaign execution, Outbox processing, Tenant resolution, Commercial truth |

**Zero of these ownership invariants has an executable test.** The repository's only runnable test file contains no assertions.

---

## 4. Active modules

### 4.1 Routes

| Location | Purpose |
|---|---|
| `server.ts` (~70 inline handlers) | Every domain surface — leads, inbox, knowledge, logs, pipeline, company-brain, settings, campaigns, investors, partners, meetings, dashboard, analytics, integrations, autopilot, growth-command. Firestore I/O is inline in each handler; there is no controller or repository layer at runtime. No handler validates its request body. |
| `server.ts:309-344` | A block of ~30 hardcoded success stubs: `/api/inbox/:id/reply`, `/api/inbox/auto-reply-all`, `/api/leads/batch-followup`, `/api/meetings/:id/process-payment`, `/api/inbox/deep-audit` → `"Clean"`, `/api/inbox/sales-decision-engine/inspect` → `"Proceed"`, `/api/inbox/circuit-breaker/toggle`, and more. Each returns fabricated success that the UI renders as fact. |
| `server/routes/stripe.routes.ts` | Checkout session creation and webhook receiver. Signature verification is written correctly and defeated by the global `express.json()`. |
| `server/routes/outbox.routes.ts` | Human review console: list / approve / reject. Reads and writes the Postgres table while the worker reads Firestore. All three routes 500 in dev. |

### 4.2 Services (live)

| Module | One-line purpose |
|---|---|
| `aiSafety.service.ts` | Stale-draft check and human-ownership-lock writer. Imported by the outbox worker and **never called**; the field it reads has no writer. |
| `aiSecurity.service.ts` | `detectPromptInjection` (8-phrase substring blocklist) and `sanitizeInboundText` (regex tag-stripper). The sanitizer has zero callers. |
| `canary.ts` | Canary/rollout utilities. |
| `gmail.service.ts` | Gmail API adapter: history list, message get, MIME send. Hand-rolled MIME parser with no charset, quoted-printable, RFC 2047 or attachment handling; every HTTP failure collapses into one generic thrown string. |
| `gmailHistorySync.service.ts` | Pub/Sub history event → per-message ingestion loop, uncapped. Its first statement hits the throwing Drizzle proxy. |
| `identityResolver.service.ts` | Email → contact/account resolution. Accepts `organizationId` and never uses it; queries are global. |
| `inboundPipeline.ts` | The live inbound path: persist message → resolve identity → synthesize memory → classify → compose → enqueue. Every persistence call hits the throwing proxy; the whole body is wrapped in a swallowing `catch`. Its independent-audit step is a hardcoded `PASS`. |
| `ledgers.service.ts` | Reads for question / objection / commitment / quote ledgers. Three of four read functions have zero callers; the fourth is called with an email where a contact id is expected. No writer exists for any ledger. |
| `metrics.service.ts` | 21 lines. One `console.warn` above 2000 ms; `incrementCounter` has an empty body and zero call sites. |
| `outbox.service.ts` | Firestore outbox: enqueue, fetch pending, mark processed/failed. `orgId` hardcoded in all four methods. Its only producer is dead code; `markFailed` is terminal. |
| `privacy.service.ts` | GDPR erasure and PII anonymisation. Imported by `server.ts` and **never invoked** — there is no live erasure path. |

### 4.3 Agents (live)

| Module | One-line purpose |
|---|---|
| `clientIdentityResolver.ts` | 5-tier identity ladder over `globalStore`. Its email normaliser corrupts real RFC 5322 `From` headers, degrading every exact match to a domain match. Imported by `server.ts`, never called there. |
| `companyBrainAgent.ts` | Generates the company knowledge object from a Gemini prompt. Interpolates URLs into prompts; performs no outbound fetch. |
| `conversationMemoryAgent.ts` | Rebuilds `ConversationMemory` from the whole transcript on every call, with no fact identity and no supersession. Emits hardcoded "BST" meeting slots. |
| `growthCommandAgent.ts` | Natural-language command → workflow plan. Also the module four React files import a type from, forming the only `src/` → `server/` edge. |
| `independentAuditor.ts` | Reply QC: suppression, circuit breaker, claim grounding, pricing integrity. **Not called on the live send path** — `inboundPipeline` substitutes a hardcoded PASS. Its only live invocation is the test-matrix endpoint, and it returns a hardcoded all-clean safety result regardless of what its own checks found. |
| `multiAgentReplySystem.ts` | Two-stage analysis and composition pipeline. Exported, imported by `server.ts`, and never invoked — its route is a stub. Also owns `validateAndEnforceNoPhonePolicy` and `normalizeMergeTags`, which `server.ts` does call. |
| `pitchBattleAgent.ts` | Pitch simulation. The only agent that constructs `GoogleGenAI` directly instead of going through `geminiClient`. |
| `salesDecisionEngine.ts` | The de-facto brain: circuit-breaker state, rule-based email understanding, buying stage, purchase/meeting readiness, next-best-action, the suppression check, `CANONICAL_KNOWLEDGE`, and the non-AI fallback composer. |
| `salesEngineTestMatrix.ts` | 21 hardcoded scenarios that self-report a pass rate. Labelled "70-Scenario" in both the code comment and the UI. Exposed at `POST /api/inbox/run-test-matrix`, which returns `success: true` regardless of results. |
| `trustedCtaRegistry.ts` | Allowlisted CTA URLs and booking links. |

### 4.4 Workers and runners

| Module | One-line purpose |
|---|---|
| `server/workers/outbox.worker.ts` | 5-second `setInterval` polling the Firestore outbox. No re-entrancy guard, no lease, no atomic claim, no attempt counter, no retry. Every failure path terminates in `markFailed`. Its first per-job statement hits the throwing proxy. |
| `server/autopilotRunner.ts` | Thin wrapper over `outboxWorker.start()` / `.stop()`. `stopBackgroundLoop` has no caller; `startBackgroundLoop` returns `void` into a variable the toggle route serialises as `isActive`. |

### 4.5 Policies

| Module | One-line purpose |
|---|---|
| `claimGrounding.ts` | Grounding check. Entire rule: if the body mentions a price and does not contain the substring `£499`, flag it. Imports the knowledge table and never queries it. |
| `outreachPolicy.ts` | Jurisdiction and consent gate. Both block rules are conjoined with `&& !context.isB2B`, and the sole caller hardcodes `isB2B: true`, so it can never return a block. It also compares `country === 'DE'` against values stored as full country names. |
| `policyEngine.ts` | The only ALLOW / BLOCK / ESCALATE / REQUIRE_APPROVAL implementation in the repo. **Zero call sites.** Defaults to ALLOW, and its confidence gate is skipped when confidence is `undefined`. |
| `workflowBudgets.ts` | `BudgetTracker` with step / model-call / token / cost ceilings. One consumer, fed hardcoded literals once per workflow, structurally incapable of tripping. |

### 4.6 Gateway and infrastructure

| Module | One-line purpose |
|---|---|
| `server/gateway/actionGateway.ts` | The intended single exit to all external side effects. Implements `EMAIL_SEND` and `CALENDAR_CREATE`; declares but does not implement `PAYMENT_CREATE` and `SIGNATURE_SEND`. Writes a mutable, merge-in-place audit document to `organizations/{org}/actionLogs` that nothing ever reads, and fails open (audit write errors are swallowed while dispatch proceeds). |
| `server/firebase.ts` | Firebase **client** SDK init for Firestore, plus admin SDK for Auth only. The server holds no admin credential for data access. |
| `server/db/index.ts` | Drizzle pool, or a throwing `Proxy` when `DATABASE_URL` is unset. |
| `server/db/schema.ts` | 19 `pgTable` declarations. No `version` column anywhere, no `uniqueIndex`, no `check()`, no `pgEnum`, no index on any organization column, and 5 total occurrences of an organization column across all 19 tables. |
| `server/geminiClient.ts` | `safeGenerateJSON`: tries 4 deduplicated candidate models in a loop whose entire `catch` body is `continue`, then returns `options.fallbackData` — indistinguishable to callers from a real model answer. Discards `usageMetadata`, so no token or cost accounting is possible. |
| `server/config/environment.ts` | Env parsing. Guards only `isProduction && demoMode`; `GEMINI_API_KEY` defaults to `''` with no boot-time check, and the `REAL_*` flags are not declared here at all. |
| `server/middleware/auth.ts` | See the canonical owner table. |
| `server/dataStore.ts` | 2250-line in-memory + JSON-file store, seeded with ~400 synthetic leads. Loaded at boot; referenced by `server.ts` zero times, but read by four live modules. |
| `server/seedLeadsGenerator.ts` | Manufactures the synthetic history, including fabricated `emailStatus: "OPENED"/"CLICKED"`, `openCount`, `spamScore: 0.0`, `qcScore` and `deliverabilityStatus: "VERIFIED_CLEAN"`. |

### 4.7 Frontend

`src/main.tsx` → `src/App.tsx` → pages (`InboxView`, `LeadsView`, `CampaignsView`, `MeetingsView`, `OutboxView`, `SettingsView`, `AnalyticsView`, `IntegrationsView`, `GrowthAgentView`) and components. All API access goes through `src/lib/apiFetch.ts`, which returns the raw `Response` and performs no error normalisation — every call site branches on `res.ok` and discards the error body, so a policy block, an expired token and a 500 are indistinguishable to the user.

Four client modules import a **server** module by relative path (`../server/agents/growthCommandAgent`) for a type. None uses `import type`, and `tsconfig.json` sets `isolatedModules` without `verbatimModuleSyntax`, so only esbuild's dead-import elision currently keeps `@google/genai` and the `GEMINI_API_KEY` read out of the browser bundle. There are also two import cycles: `dataStore.ts` ↔ `multiAgentReplySystem.ts`, and `CampaignsView.tsx` ↔ `CampaignCompareModal.tsx`.

---

## 5. Dead code — 25 unreachable files

Unreachable from both entrypoints by static import traversal. Disposition is a recommendation, not a record of a decision.

| # | File | Disposition | Reason |
|---|---|---|---|
| 1 | `server/agents/campaignAgent.ts` | DELETE | Campaign execution has no owner; this is not it, and nothing imports it. |
| 2 | `server/agents/emailUnderstanding.agent.ts` | ⚠️ QUARANTINE | The **only** `zod` consumer in the repository. Its schema-validated understanding is strictly stronger than the live rule-based path. Port the validation before deleting. |
| 3 | `server/agents/inboxAgent.ts` | DELETE | Superseded by `salesDecisionEngine` + `multiAgentReplySystem`. Carries its own hardcoded "BST" meeting slots. |
| 4 | `server/agents/investorAgent.ts` | DELETE | The live investor surface is three CRUD routes in `server.ts`. |
| 5 | `server/agents/leadScoringAgent.ts` | DELETE | No live scoring path exists. |
| 6 | `server/agents/meetingAgent.ts` | DELETE | Meetings are created by an inline `addDoc` in `server.ts`. |
| 7 | `server/agents/partnerAgent.ts` | DELETE | As `investorAgent`. |
| 8 | `server/agents/qualityControlAgent.ts` | DELETE | `independentAuditor` is the live QC module, such as it is. Two QC agents is one too many. |
| 9 | `server/agents/replyComposer.agent.ts` | ⚠️ DELETE | **Dangerous.** A third reply composer alongside two non-functioning live candidates; its presence makes "which composer runs?" unanswerable by reading. |
| 10 | `server/agents/technical.agent.ts` | DELETE | Specialist agent for a specialist system that is never invoked (`specialistsRequired` is computed and read by nothing). |
| 11 | `server/controllers/killSwitch.controller.ts` | ⚠️ REVIVE-AND-WIRE | **The only working kill switch in the repository.** The route the UI posts to (`server.ts:337`) is a stub that mutates nothing, and `tripCircuitBreaker` is imported but never called. This file is the fix. Highest-value revival in the list. |
| 12 | `server/policies/jurisdictionPolicy.ts` | ⚠️ REVIVE-AND-WIRE | The **only fail-closed default in the entire codebase** (`default: { allowColdOutreach: false, requiresDoubleOptIn: true }`). The live `outreachPolicy` fails open and cannot block. |
| 13 | `server/repositories/contact.repository.ts` | DELETE | The entire repository layer is dead; zero importers repo-wide. |
| 14 | `server/repositories/conversation.repository.ts` | DELETE | As above. |
| 15 | `server/repositories/message.repository.ts` | DELETE | As above. There is no data-access abstraction at runtime — every handler does inline Firestore or Drizzle I/O. |
| 16 | `server/services/buyingStage.service.ts` | DELETE | Duplicates `salesDecisionEngine.computeBuyingStage`. |
| 17 | `server/services/calendar.service.ts` | ⚠️ QUARANTINE | Duplicates the gateway's calendar path and is **worse** (`checkFreeBusy` is `return true`; `validateBusinessHours` computes an hour and discards it). But it is the only place that *models* free/busy enforcement, which the live gateway computes and throws away. Port the intent, then delete. |
| 18 | `server/services/claimGrounding.service.ts` | ⚠️ QUARANTINE | Contains the only `APPROVED` / `DRAFT` / `RETIRED` knowledge lifecycle in the repo. The live `policies/claimGrounding.ts` is a substring check. Port the lifecycle. |
| 19 | `server/services/nextBestAction.service.ts` | DELETE | Duplicates `salesDecisionEngine.determineNextBestAction`. |
| 20 | `server/services/pipeline.service.ts` | 🚨 DELETE — HIGHEST PRIORITY | **The most dangerous file in the repository.** A complete second inbound pipeline importing six other dead modules (#2, #9, #10, #16, #19, #22), and the *only* producer for the Firestore outbox the live worker polls. It reads as production code, and the live outbox is inert precisely because this file — not the live pipeline — is what feeds it. |
| 21 | `server/services/privacyOps.service.ts` | DELETE | Duplicates `privacy.service.ts`, which is itself imported and never invoked — so there is no live erasure path either way. |
| 22 | `server/services/suppression.service.ts` | ⚠️ QUARANTINE | The live `isSuppressed` has no persistence at all. This has persistence, but on a Node process global — lost on restart, not shared across instances, fail-open on an uninitialised list. Port the *concept*, not the implementation. Do not revive as-is. |
| 23 | `server/tests/adversarial.test.ts` | ⚠️ REVIVE-AND-WIRE | Dead by import graph but **executable** via `npm run test:adversarial`. It contains **zero assertions** — `passed++` runs unconditionally inside the `try`, so it prints "4/4 passed" and exits 0 for any implementation, including an empty one. A green light wired to nothing. Fix this before adding any other test. |
| 24 | `server/tests/pipeline.test.ts` | DELETE | Not wired to any npm script, contains no assertions, swallows its own failures, and imports #20 (dead). |
| 25 | `src/components/ObjectionMatrixResolver.tsx` | DELETE | No parent renders it. |

### Files flagged as dangerous

| File | Why |
|---|---|
| `server/services/pipeline.service.ts` and its six dead collaborators | A coherent parallel product. A maintainer debugging the inbound path will land here first and ship nothing. |
| `server/agents/replyComposer.agent.ts` | Third composer among three; makes reply ownership unreadable. |
| `server/services/calendar.service.ts` | `checkFreeBusy` returning `true` unconditionally means anyone who wires it up gets silent double-booking with the *appearance* of a safety check. |
| `server/services/suppression.service.ts` | Named as though it prevents a compliance failure; backed by an ephemeral process global with a fail-open `|| false`. An on-call engineer patching this file ships nothing and believes otherwise. |
| `server/controllers/killSwitch.controller.ts` | Dangerous by *absence* — the working emergency stop is unrouted while the routed one returns `{success:true}` and changes nothing. |
| `server/gateway/actionGateway.ts.patch` | A git-tracked stale unified diff whose hunk context no longer matches the live file. It would now fail to apply. Delete. |

---

## 6. Repository mutation scripts

| Location | Count | Nature |
|---|---|---|
| Repository root, `*.cjs` | 104 | One-off Node scripts that read a source file, apply a regex or string replacement, and write it back (`add_stale_draft.cjs`, `add_ambiguous.cjs`, `test_server.cjs`, `run_migrations.cjs`, and so on). |
| `archive_scripts/*.cjs` | 68 | Superseded versions of the same. Several conflict with their root-level successors — `archive_scripts/patch_outbox.cjs` injects a *version-based* staleness check that `add_stale_draft.cjs` later replaced with a wall-clock comparison. |
| **Total git-tracked `.cjs`** | **172** | |

**Reachability: zero.** `package.json` contains no `.cjs` entry except the build artifact (`"start": "node dist/server.cjs"`). No `require('./…')` exists under `server/` or `src/`. The string `archive_scripts` appears nowhere in the repository outside the directory name itself.

**What they actually are:** an undocumented, unordered, non-idempotent, unreviewed migration history for the *source tree*. Several current defects are directly traceable to them — the wall-clock staleness check that replaced a version check, and the `isAmbiguousResult` field grafted onto the gateway by string replacement.

**Recommendation:**

1. `git rm` all 172 files in a single commit. They remain recoverable from history.
2. If any script is genuinely still required, move it to `scripts/`, give it an `npm` entry, and document *why* in `AGENTS.md`. Nothing currently meets that bar.
3. Delete `server/gateway/actionGateway.ts.patch` in the same commit.
4. Add a CI check that fails the build on any new root-level `*.cjs`.

Note separately that `run_migrations.cjs` is the only migration runner in the repository, and it hardcodes `drizzle/0001_curvy_toad_men.sql` — skipping `0000` (which creates the tables `0001` references) and `0002`. It writes no ledger entry, so a second run re-executes `CREATE TABLE` and aborts. `drizzle/meta/_journal.json` lists all three migrations in correct order and `drizzle-kit` is installed; nothing invokes it, and no npm script exists for it.

---

## 7. Data-layer reality

Three stores exist. Only one serves traffic.

| Store | Status | Authoritative for | Notes |
|---|---|---|---|
| **Firestore** | **LIVE — this is the running system** | Everything the HTTP API reads or writes: contacts, conversations, knowledge, `ai_logs`, opportunities, `company_brain`, settings, campaigns, meetings, `oauth_connections`, `actionLogs`, and the outbox the worker polls | Accessed from the server via the Firebase **client** SDK. All paths are the literal `organizations/org_1/...`. `firestore.rules` is `allow read, write: if true` under `match /{document=**}`, and `firebase-applet-config.json` — containing the live project id and API key — is git-tracked and absent from `.gitignore`. Because the server uses the client SDK with no admin credential, **the rules cannot be tightened without first re-platforming server data access onto `firebase-admin`.** |
| **Drizzle / Postgres** | **DECLARED, UNCONNECTED** | Nothing | `DATABASE_URL` is empty; `db` is a `Proxy` that throws on every property access. 19 `pgTable` declarations, all aspirational: no `version` column on any table, no `uniqueIndex`, no `check()`, no `pgEnum`, no `CREATE INDEX` in any of the three migrations, and only 5 occurrences of an organization column across all 19 tables. Despite being unreachable, **four live code paths write to it** — `inboundPipeline` (messages, conversation facts, outbox), `outbox.routes` (approve/reject), `outbox.worker` (ownership lock, stale-draft check) and `identityResolver` — and every one of them throws. Those throws are caught and converted into permanent `FAILED` states or silently swallowed. This is the single largest source of silent failure in the system. |
| **`server/dataStore.ts` + `server/data_storage.json`** | **LOADED AT BOOT, SERVES NO ROUTE** | Synthetic seed data only | 2250-line in-memory store hydrated from a JSON file on disk, or seeded with ~400 generated leads. `server.ts` references `globalStore` zero times, so no HTTP route serves it. **But four live modules read it** — `salesDecisionEngine.isSuppressed`, `multiAgentReplySystem`, `clientIdentityResolver` and `middleware/auth.ts`. The suppression check therefore evaluates real prospect addresses against 400 fabricated leads: it can miss a genuine unsubscribe *and* spuriously suppress a real contact whose address collides with seed data. |

### Consequences of the three-way split

- **The outbox is severed at both ends.** The producer writes Postgres (throws); the consumer reads Firestore (empty, because its only producer is dead code); the review console reads Postgres (500s). The product has never sent an autonomous email in any environment.
- **Human approval cannot reach the send path.** Approve writes Postgres; the worker reads Firestore. Rejecting a message does not stop it being sent.
- **Safety guards read empty tables.** The human-ownership lock and the stale-draft check query Postgres `conversations` / `messages`, which the Firestore write path never populates. With Postgres connected they would pass *vacuously* — `rows.length === 0` — rather than fail. Both would look healthy and enforce nothing.
- **Suppression evaluates synthetic data.** See above.
- **Audit records are write-only.** `organizations/{org}/actionLogs` has exactly one writer and no reader anywhere in the repository or the UI.

**Rule of thumb for anyone changing behaviour:** if it must take effect at runtime, it must land in **Firestore**. A change to `server/db/schema.ts` alone enforces nothing.

---

## 8. How to keep this current

1. **Re-derive; do not hand-edit.** Rebuild the reachable and dead sets by import-graph traversal from `server.ts` and `src/main.tsx` (honouring `.ts` / `.tsx` / `index.*` resolution) whenever a file is added, removed, or has its imports changed. Regenerate §5 from that output rather than amending rows by hand.
2. **Reachable ≠ live.** After computing reachability, grep each newly-reachable symbol for actual call sites. This document exists because several modules in the "live" set — `policyEngine`, `privacy.service`, `aiSafety.service`, `independentAuditor` on the send path, `multiAgentReplySystem` — are imported and never invoked. Reachability alone would have marked them healthy.
3. **The owner table is the contract.** Any change that adds a second path to a capability in §3 must either update that row to say the capability is now contested, or delete the path it duplicates. A row reading "single canonical owner" is a claim; treat it as false until a test enforces it.
4. **Add the enforcement this document currently substitutes for.** In priority order: a `dependency-cruiser` or `eslint-plugin-import` rule banning `src/` → `server/` imports and import cycles; a lint-banned `'org_1'` literal; a CI grep failing the build on new root-level `*.cjs`; a build-time assertion that the emitted client bundle contains no `GoogleGenAI`. Each of those converts a paragraph here into a gate.
5. **Fix the test file before writing tests.** `server/tests/adversarial.test.ts` passes unconditionally today. Any coverage added alongside it inherits the same false-green risk until `passed++` is moved behind a real comparison against `expectedToFail`.
6. **Review trigger.** Regenerate this document on: any change to `server.ts`'s route table; any new file under `server/services/`, `server/agents/` or `server/policies/`; any change to which datastore a write path targets; and before every release. Stamp the commit SHA at the top when you do.
