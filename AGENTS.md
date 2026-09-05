# ADDITIONAL NON-NEGOTIABLE PRODUCTION REQUIREMENTS

The following requirements supersede any conflicting earlier implementation behavior.

## A. SAFE REBUILD MODE
During the entire rebuild, real external side effects must remain disabled unless an explicitly configured staging/test provider is being used.
Default during development:
REAL_EMAIL_SEND_ENABLED=false  
REAL_CALENDAR_CREATE_ENABLED=false  
REAL_PAYMENT_ENABLED=false  
REAL_SIGNATURE_ENABLED=false  
REAL_LINKEDIN_SEND_ENABLED=false  
Do not send real emails to prospects while implementing or testing.
Do not create real customer meetings while implementing or testing.
Do not charge real payment methods.
Do not initiate real agreements.
Do not interact with real LinkedIn recipients.
Use dedicated test accounts, test calendars, provider sandboxes, mocks and fixtures.
Production action flags must fail closed.

## B. REPOSITORY STABILITY RULE
At the end of EVERY implementation phase:
- application must compile;
- database migrations must be valid;
- existing tests must pass;
- newly added tests must pass;
- frontend build must pass;
- production build must pass;
- no known P0 issue introduced during the phase may remain unresolved.
Do not begin the next phase while the repository is broken.
Avoid uncontrolled whole-repository rewrites. Refactor incrementally.

## C. CENTRAL PRODUCTION ACTION GATEWAY
No agent, controller or business service may directly perform external side effects.
Create a central Production Action Gateway.
All external actions must pass through it:
EMAIL_SEND, CALENDAR_CREATE, CALENDAR_UPDATE, CALENDAR_CANCEL, PAYMENT_CREATE, SIGNATURE_SEND, CRM_UPDATE, EXTERNAL_MESSAGE_SEND.
The Action Gateway must enforce: authentication, authorization, tenant isolation, policy, suppression, idempotency, state validity, provider readiness, feature flag, kill switch, audit logging.
Agents propose actions. The Action Gateway authorizes and dispatches approved actions.

## D. STALE DRAFT PROTECTION
Every AI draft must reference the latest inbound message/version used to generate it.
Immediately before sending: reload the conversation. If any newer inbound message has arrived: invalidate the draft. Do not send it. Re-run conversation intelligence using the updated thread.

## E. AMBIGUOUS PROVIDER RESULT
Handle situations where an external provider may have completed an action but the network response was lost. Set: AMBIGUOUS_PROVIDER_RESULT. Then reconcile against the provider. Only retry after confirming the action did not occur.

## F. FACT FRESHNESS
Conversation/account facts require provenance AND freshness. Support: observedAt, lastVerifiedAt, validFrom, validUntil, supersededBy.

## G. CUSTOMER COMMITMENT LEDGER
Create structured commitments. Store: accountId, contactId, conversationId, commitment, sourceMessageId, madeBy, dueDate, status, riskLevel. Before sending a reply, check whether we have unresolved commitments to the client.

## H. QUESTION LEDGER
Persist important client questions. Statuses: OPEN, PARTIALLY_ANSWERED, ANSWERED, DEFERRED, HUMAN_REQUIRED. Before sending: compare important client questions against answers contained in the proposed response.

## I. OBJECTION LEDGER
Persist objections. Store: type, statement, sourceMessageId, severity, status, resolution, resolvedAt.

## J. STAKEHOLDER MAP
Support multiple contacts per account. Stakeholder roles: CHAMPION, DECISION_MAKER, TECHNICAL_EVALUATOR, FINANCE, PROCUREMENT, USER, BLOCKER, UNKNOWN.

## K. QUOTE SNAPSHOT
Create persistent Quote records (pricingVersion, quotedAt, expiresAt, etc.). If a client has an active quote, conversation agents must consider it before using current public pricing.

## L. CLAIM-LEVEL GROUNDING
Every material customer-facing product/technical/commercial claim should be traceable internally to approved evidence where practical. 

## M. AI WORKFLOW BUDGETS
Create configurable limits: maxAgentStepsPerReply, maxModelCallsPerReply, maxRetriesPerAgent, maxTokensPerReplyWorkflow, maxCostPerReply, maxDecisionLatency. If limits exceeded: stop autonomous processing, move to human review.

## N. GMAIL EDGE CASES
Gmail synchronization system must handle duplicate notifications, out-of-order, expired history, deleted, archived, sent, drafts, labels, aliases, CC, forwarded, quoted content, eventual consistency.

## O. CALENDAR EDGE CASES
Before meeting creation: resolve timezone, check free/busy, check business hours, check conflicts, validate duration, verify email, create real event, retrieve IDs.

## P. HUMAN OWNERSHIP LOCK
When a human takes ownership: set AUTONOMY_PAUSED_BY_HUMAN. No autonomous message/meeting may occur until explicitly resumed.

## Q. JURISDICTION-AWARE OUTREACH POLICY
Create a configurable outreach policy layer based on recipient country, campaign type, consent, etc.

## R. PRIVACY OPERATIONS
Support: contact/org export, deletion/anonymization, retention expiration, model-input minimization.

## S. AI SECURITY / RED TEAM TESTS
Add adversarial tests for: prompt injection, HTML injection, Unicode tricks, very long messages, malicious URLs, system-prompt extraction. Client email text is untrusted data.

## T. SUPPLY CHAIN SECURITY
Dependency auditing, SAST, lockfile checks.

## U. SAFE DATABASE MIGRATIONS
Prefer backward-compatible migrations. Use expand-and-contract.

## V. STAGING IS MANDATORY
Production deployment path: dev -> tests -> CI -> staging -> staging E2E -> shadow mode -> controlled rollout -> production.

## W. CANARY AUTONOMY
New AI/policy behavior must support controlled rollout by workspace, mailbox, campaign, percentage.

## X. EXECUTABLE READINESS CHECK
Create: \`npm run readiness\` or equivalent to verify db, queue, gmail, calendar, AI, pricing, sender identity, action gateway, kill switches.

## Y. AI RELEASE EVALUATION
Create measurable evaluation metrics. Critical safety cases must have zero known failures before autonomous production rollout.

## Z. OPERATING SLOS & ALERTS
Define targets for inbound latency, AI latency, send success, duplicate rate, policy blocks.

## AA. BACKUP RESTORE VERIFICATION
Document recovery objectives. Perform restore tests.

## AB. FINAL RELEASE PROCESS
Run all tests, readiness checks, shadow modes, and reviews before full autopilot. FULL AUTOPILOT is an operational maturity state, not a code-completion state.

# FINAL ENGINEERING STANDARD
The objective is a production-grade, testable, observable, secure, failure-tolerant, auditable autonomous sales system that fails safely when uncertain and never fabricates external actions. Correct understanding and safe execution come first.
