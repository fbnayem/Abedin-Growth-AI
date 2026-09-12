# Active Code Graph

**Generated** by `scripts/generate-code-graph.ts` from `server/build/codeGraph.ts`. Do not edit; regenerate with `npm run code-graph`.
`codeGraph.invariant.test.ts` regenerates this file and refuses any difference from the committed copy, so it cannot describe a tree other than the one it is committed with.

## 1. How this is derived

Every import is followed from the runtime entrypoints — `server.ts` and `src/main.tsx` — relative, `@/` alias and dynamic alike, with comments blanked by the same scanner the route table uses.
A module is **live** if a path of imports reaches it from a runtime entrypoint, **operational** if only a script invoked by package.json or a workflow under `.github/workflows` reaches it, and **dead** if nothing does.
Capability ownership is reported as *which live modules import the provider*, and the dependency surface as *which live modules import the package*: that is what the code knows. Nothing here says who ought to.

## 2. Entrypoints

| Entrypoint | Live modules reached |
|---|---|
| `server.ts` | 122 |
| `src/main.tsx` | 62 |

Live modules in total: **176**. Dead files: **0**. Operational-only modules: **1**. Script invocations: **40**. Scripts reached by nothing: **0**.

## 3. Capability providers and their live importers

| Capability | Provider module | Live importers |
|---|---|---|
| Email send/read (Gmail) | `server/services/gmail.service.ts` | `server/gateway/actionGateway.ts`, `server/services/gmailHistorySync.service.ts`, `server/services/inboundPipeline.ts` |
| Calendar | `server/services/calendar.service.ts` | `server/gateway/actionGateway.ts` |
| Outbound HTTP (fetch with timeout) | `server/lib/httpClient.ts` | `server/gateway/actionGateway.ts`, `server/lib/providerError.ts`, `server/services/calendar.service.ts`, `server/services/gmail.service.ts` |
| Model generation | `server/geminiClient.ts` | `server/agents/companyBrainAgent.ts`, `server/agents/conversationMemoryAgent.ts`, `server/agents/growthCommandAgent.ts`, `server/agents/pitchBattleAgent.ts`, `server/agents/salesDecisionEngine.ts` |
| Document store | `server/store/index.ts` | `server.ts`, `server/build/schemaCompatibility.ts`, `server/gateway/actionGateway.ts`, `server/lib/concurrency.ts`, `server/lib/factStore.ts`, `server/lib/identityStore.ts`, `server/lib/runLog.ts`, `server/middleware/tenant.ts`, `server/services/actionTrail.service.ts`, `server/services/autonomyLock.service.ts`, `server/services/circuitBreaker.service.ts`, `server/services/deliverability.service.ts`, `server/services/draftIntegrity.service.ts`, `server/services/inboundPipeline.ts`, `server/services/outbox.service.ts`, `server/services/tenantSpend.service.ts`, `server/services/unsubscribe.service.ts`, `server/tenancy/organizations.ts`, `server/workers/outbox.worker.ts` |
| Relational database | `server/db/index.ts` | `server/dataStore.ts`, `server/routes/stripe.routes.ts`, `server/services/gmailHistorySync.service.ts`, `server/services/identityResolver.service.ts`, `server/services/inboundPipeline.ts`, `server/services/ledgers.service.ts`, `server/store/index.ts`, `server/workers/outbox.worker.ts` |
| External side effects (the gateway) | `server/gateway/actionGateway.ts` | `server.ts`, `server/workers/outbox.worker.ts` |
| Outbox queue | `server/services/outbox.service.ts` | `server/gateway/actionGateway.ts`, `server/routes/outbox.routes.ts`, `server/services/circuitBreaker.service.ts`, `server/services/inboundPipeline.ts`, `server/workers/outbox.worker.ts` |

## 4. Packages imported by live server modules

The server's dependency surface by importer: every package a live module outside `src/` imports, and which modules import it. Node built-ins are omitted.

| Package | Live importers |
|---|---|
| `@google/genai` | `server/geminiClient.ts` |
| `cors` | `server.ts` |
| `dotenv` | `server.ts`, `server/config/safeMode.ts` |
| `drizzle-orm` | `server/dataStore.ts`, `server/db/index.ts`, `server/db/schema.ts`, `server/services/gmailHistorySync.service.ts`, `server/services/identityResolver.service.ts`, `server/services/inboundPipeline.ts`, `server/services/ledgers.service.ts`, `server/workers/outbox.worker.ts` |
| `express` | `server.ts`, `server/lib/concurrency.ts`, `server/lib/errors.ts`, `server/lib/validation.ts`, `server/middleware/auth.ts`, `server/middleware/rateLimit.ts`, `server/middleware/securityHeaders.ts`, `server/middleware/tenant.ts`, `server/routes/actionTrail.routes.ts`, `server/routes/autonomy.routes.ts`, `server/routes/cspReport.routes.ts`, `server/routes/deliverability.routes.ts`, `server/routes/openapi.routes.ts`, `server/routes/outbox.routes.ts`, `server/routes/spend.routes.ts`, `server/routes/stripe.routes.ts`, `server/routes/unsubscribe.routes.ts`, `server/services/webhookVerification.service.ts`, `server/tenancy/orgScope.ts` |
| `firebase-admin` | `server/firebase.ts` |
| `pg` | `server/db/index.ts`, `server/store/index.ts` |
| `stripe` | `server/routes/stripe.routes.ts` |
| `uuid` | `server/lib/runLog.ts`, `server/services/inboundPipeline.ts`, `server/services/outbox.service.ts`, `server/store/index.ts`, `server/workers/outbox.worker.ts` |
| `vite` | `server.ts` |
| `zod` | `server/build/apiSurface.ts`, `server/build/openapi.ts`, `server/domain/apiContracts.ts`, `server/domain/outboxEnvelope.ts`, `server/lib/validation.ts` |

## 5. Live modules by directory

### (root)

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server.ts` | 0 | server.ts |

### server

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/autopilotRunner.ts` | 1 | server.ts |
| `server/dataStore.ts` | 4 | server.ts |
| `server/firebase.ts` | 1 | server.ts |
| `server/geminiClient.ts` | 5 | server.ts |
| `server/seedLeadsGenerator.ts` | 1 | server.ts |

### server/agents

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/agents/clientIdentityResolver.ts` | 2 | server.ts |
| `server/agents/companyBrainAgent.ts` | 1 | server.ts |
| `server/agents/conversationMemoryAgent.ts` | 1 | server.ts |
| `server/agents/growthCommandAgent.ts` | 1 | server.ts |
| `server/agents/independentAuditor.ts` | 3 | server.ts |
| `server/agents/multiAgentReplySystem.ts` | 3 | server.ts |
| `server/agents/pitchBattleAgent.ts` | 1 | server.ts |
| `server/agents/salesDecisionEngine.ts` | 6 | server.ts |
| `server/agents/salesEngineTestMatrix.ts` | 1 | server.ts |
| `server/agents/trustedCtaRegistry.ts` | 4 | server.ts |

### server/build

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/build/apiSurface.ts` | 1 | server.ts |
| `server/build/health.ts` | 1 | server.ts |
| `server/build/openapi.ts` | 1 | server.ts |
| `server/build/provenance.ts` | 2 | server.ts |
| `server/build/routeTable.ts` | 1 | server.ts |
| `server/build/schemaCompatibility.ts` | 3 | server.ts |

### server/config

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/config/environment.ts` | 7 | server.ts |
| `server/config/port.ts` | 1 | server.ts |
| `server/config/safeMode.ts` | 4 | server.ts |

### server/db

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/db/index.ts` | 8 | server.ts |
| `server/db/schema.ts` | 7 | server.ts |
| `server/db/tls.ts` | 1 | server.ts |

### server/domain

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/domain/abstention.ts` | 5 | server.ts |
| `server/domain/actionAudit.ts` | 1 | server.ts |
| `server/domain/adjudication.ts` | 4 | server.ts |
| `server/domain/apiContracts.ts` | 3 | server.ts |
| `server/domain/attachmentPolicy.ts` | 1 | server.ts |
| `server/domain/automatedMail.ts` | 1 | server.ts |
| `server/domain/autonomyLock.ts` | 3 | server.ts |
| `server/domain/campaignSafety.ts` | 1 | server.ts |
| `server/domain/checkoutPrice.ts` | 1 | server.ts |
| `server/domain/contactMerge.ts` | 1 | server.ts |
| `server/domain/contextBundle.ts` | 3 | server.ts |
| `server/domain/facts.ts` | 3 | server.ts |
| `server/domain/ledgerAdapters.ts` | 1 | server.ts |
| `server/domain/memoryFacts.ts` | 1 | server.ts |
| `server/domain/operatorAction.ts` | 7 | server.ts |
| `server/domain/outboxEnvelope.ts` | 2 | server.ts |
| `server/domain/promptInjection.ts` | 1 | server.ts |
| `server/domain/replyLoop.ts` | 1 | server.ts |
| `server/domain/senderIdentity.ts` | 2 | server.ts |
| `server/domain/slo.ts` | 1 | server.ts |
| `server/domain/stateMachines.ts` | 2 | server.ts |
| `server/domain/threadResolution.ts` | 1 | server.ts |
| `server/domain/unsubscribe.ts` | 4 | server.ts |

### server/gateway

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/gateway/actionGateway.ts` | 2 | server.ts |

### server/lib

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/lib/capabilities.ts` | 5 | server.ts |
| `server/lib/concurrency.ts` | 2 | server.ts |
| `server/lib/emailKey.ts` | 3 | server.ts |
| `server/lib/errors.ts` | 15 | server.ts |
| `server/lib/factStore.ts` | 1 | server.ts |
| `server/lib/fields.ts` | 3 | server.ts |
| `server/lib/httpClient.ts` | 4 | server.ts |
| `server/lib/identity.ts` | 3 | server.ts |
| `server/lib/identityStore.ts` | 1 | server.ts |
| `server/lib/messageIdentity.ts` | 3 | server.ts |
| `server/lib/mime.ts` | 3 | server.ts |
| `server/lib/modelCallLog.ts` | 3 | server.ts |
| `server/lib/promptAssembly.ts` | 3 | server.ts |
| `server/lib/providerError.ts` | 6 | server.ts |
| `server/lib/providerId.ts` | 2 | server.ts |
| `server/lib/reconciliation.ts` | 2 | server.ts |
| `server/lib/runLog.ts` | 1 | server.ts |
| `server/lib/singleton.ts` | 1 | server.ts |
| `server/lib/validation.ts` | 2 | server.ts |

### server/middleware

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/middleware/auth.ts` | 1 | server.ts |
| `server/middleware/authAllowlist.ts` | 1 | server.ts |
| `server/middleware/rateLimit.ts` | 1 | server.ts |
| `server/middleware/securityHeaders.ts` | 1 | server.ts |
| `server/middleware/tenant.ts` | 1 | server.ts |

### server/policies

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/policies/claimGrounding.ts` | 1 | server.ts |
| `server/policies/modelPricing.ts` | 2 | server.ts |
| `server/policies/outreachPolicy.ts` | 1 | server.ts |
| `server/policies/policyEngine.ts` | 1 | server.ts |
| `server/policies/version.ts` | 1 | server.ts |
| `server/policies/workflowBudgets.ts` | 2 | server.ts |

### server/providers

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/providers/types.ts` | 3 | server.ts |

### server/routes

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/routes/actionTrail.routes.ts` | 1 | server.ts |
| `server/routes/autonomy.routes.ts` | 1 | server.ts |
| `server/routes/cspReport.routes.ts` | 1 | server.ts |
| `server/routes/deliverability.routes.ts` | 1 | server.ts |
| `server/routes/openapi.routes.ts` | 1 | server.ts |
| `server/routes/outbox.routes.ts` | 1 | server.ts |
| `server/routes/spend.routes.ts` | 1 | server.ts |
| `server/routes/stripe.routes.ts` | 1 | server.ts |
| `server/routes/unsubscribe.routes.ts` | 1 | server.ts |

### server/services

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/services/actionTrail.service.ts` | 1 | server.ts |
| `server/services/alerting.service.ts` | 1 | server.ts |
| `server/services/autonomyLock.service.ts` | 1 | server.ts |
| `server/services/calendar.service.ts` | 1 | server.ts |
| `server/services/circuitBreaker.service.ts` | 3 | server.ts |
| `server/services/deliverability.service.ts` | 2 | server.ts |
| `server/services/draftIntegrity.service.ts` | 2 | server.ts |
| `server/services/gmail.service.ts` | 3 | server.ts |
| `server/services/gmailHistorySync.service.ts` | 1 | server.ts |
| `server/services/identityResolver.service.ts` | 1 | server.ts |
| `server/services/inboundPipeline.ts` | 1 | server.ts |
| `server/services/ledgers.service.ts` | 2 | server.ts |
| `server/services/metrics.service.ts` | 1 | server.ts |
| `server/services/outbox.service.ts` | 5 | server.ts |
| `server/services/tenantSpend.service.ts` | 2 | server.ts |
| `server/services/unsubscribe.service.ts` | 1 | server.ts |
| `server/services/webhookVerification.service.ts` | 1 | server.ts |

### server/store

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/store/index.ts` | 19 | server.ts |

### server/tenancy

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/tenancy/orgScope.ts` | 23 | server.ts |
| `server/tenancy/organizations.ts` | 2 | server.ts |

### server/workers

| Module | Imported by (live) | Reached from |
|---|---|---|
| `server/workers/outbox.worker.ts` | 2 | server.ts |

### shared/domain

| Module | Imported by (live) | Reached from |
|---|---|---|
| `shared/domain/autonomyDisplay.ts` | 3 | server.ts, main.tsx |
| `shared/domain/enums.ts` | 1 | server.ts, main.tsx |
| `shared/domain/growthCommand.ts` | 5 | server.ts, main.tsx |
| `shared/domain/meetingRecovery.ts` | 1 | main.tsx |
| `shared/domain/models.ts` | 18 | server.ts, main.tsx |
| `shared/domain/pricing.ts` | 12 | server.ts, main.tsx |
| `shared/domain/quote.ts` | 6 | server.ts |
| `shared/domain/time.ts` | 6 | server.ts, main.tsx |

### shared/lib

| Module | Imported by (live) | Reached from |
|---|---|---|
| `shared/lib/csvSafety.ts` | 2 | server.ts, main.tsx |

### src

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/App.tsx` | 1 | main.tsx |
| `src/main.tsx` | 0 | main.tsx |
| `src/types.ts` | 39 | server.ts, main.tsx |

### src/components

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/components/AddInvestorModal.tsx` | 1 | main.tsx |
| `src/components/AddKnowledgeModal.tsx` | 1 | main.tsx |
| `src/components/AddLeadModal.tsx` | 1 | main.tsx |
| `src/components/AddPartnerModal.tsx` | 1 | main.tsx |
| `src/components/AutonomousGrowthPipelineCard.tsx` | 1 | main.tsx |
| `src/components/CommandBar.tsx` | 1 | main.tsx |
| `src/components/DeliverabilityScanner.tsx` | 2 | main.tsx |
| `src/components/DiscoverInvestorsModal.tsx` | 1 | main.tsx |
| `src/components/DiscoverLeadsModal.tsx` | 1 | main.tsx |
| `src/components/DiscoverPartnersModal.tsx` | 1 | main.tsx |
| `src/components/Header.tsx` | 1 | main.tsx |
| `src/components/LiveMeetingBattlecardModal.tsx` | 1 | main.tsx |
| `src/components/LiveMeetingRoomModal.tsx` | 1 | main.tsx |
| `src/components/LivePhoneTestWidget.tsx` | 2 | main.tsx |
| `src/components/MissedMeetingRecoveryModal.tsx` | 1 | main.tsx |
| `src/components/NewOpportunityModal.tsx` | 1 | main.tsx |
| `src/components/PitchSimulatorModal.tsx` | 1 | main.tsx |
| `src/components/RevenueLeakCalculator.tsx` | 1 | main.tsx |
| `src/components/ScheduleMeetingModal.tsx` | 1 | main.tsx |
| `src/components/ScoreWhyModal.tsx` | 1 | main.tsx |
| `src/components/SequenceCadenceViewer.tsx` | 1 | main.tsx |
| `src/components/Sidebar.tsx` | 1 | main.tsx |
| `src/components/WorkflowPlanModal.tsx` | 1 | main.tsx |

### src/lib

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/lib/apiFetch.ts` | 17 | main.tsx |
| `src/lib/emptyCompanyBrain.ts` | 1 | main.tsx |
| `src/lib/firebase.ts` | 2 | main.tsx |
| `src/lib/firebaseConfig.ts` | 1 | main.tsx |

### src/pages

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/pages/AnalyticsView.tsx` | 1 | main.tsx |
| `src/pages/CampaignCompareModal.tsx` | 1 | main.tsx |
| `src/pages/CampaignWizardModal.tsx` | 1 | main.tsx |
| `src/pages/CampaignsView.tsx` | 2 | main.tsx |
| `src/pages/CompaniesView.tsx` | 1 | main.tsx |
| `src/pages/DashboardView.tsx` | 1 | main.tsx |
| `src/pages/GrowthAgentView.tsx` | 1 | main.tsx |
| `src/pages/InboxView.tsx` | 1 | main.tsx |
| `src/pages/IntegrationsView.tsx` | 1 | main.tsx |
| `src/pages/InvestorDetailModal.tsx` | 1 | main.tsx |
| `src/pages/InvestorsView.tsx` | 1 | main.tsx |
| `src/pages/KnowledgeView.tsx` | 1 | main.tsx |
| `src/pages/LeadDetailModal.tsx` | 1 | main.tsx |
| `src/pages/LeadsView.tsx` | 1 | main.tsx |
| `src/pages/MeetingsView.tsx` | 1 | main.tsx |
| `src/pages/OnboardingModal.tsx` | 1 | main.tsx |
| `src/pages/OutboxView.tsx` | 1 | main.tsx |
| `src/pages/PartnerDetailModal.tsx` | 1 | main.tsx |
| `src/pages/PartnersView.tsx` | 1 | main.tsx |
| `src/pages/PipelineView.tsx` | 1 | main.tsx |
| `src/pages/SettingsView.tsx` | 1 | main.tsx |

### src/services

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/services/gmailWorkspaceService.ts` | 2 | main.tsx |

### src/utils

| Module | Imported by (live) | Reached from |
|---|---|---|
| `src/utils/diagnosticFetch.ts` | 12 | main.tsx |
| `src/utils/exportUtils.ts` | 3 | main.tsx |

## 6. Operational-only modules

| Module | Reached only by |
|---|---|
| `server/build/codeGraph.ts` | `npm run code-graph` |

## 7. Dead files

None: every `.ts`/`.tsx` file under `server/`, `src/` and `shared/` (tests excluded) is reached from a runtime entrypoint or a script.

## 8. Scripts reached by nothing

None: every code file under `scripts/` is named by a package.json script or a workflow under `.github/workflows`, or is imported by one that is.

## 9. Frontend imports of server code

None (S40 holds: no file under `src/` imports from `server/`).

