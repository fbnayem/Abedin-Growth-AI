import { Router, type Request, type Response } from 'express';
import { getCircuitBreakerState, setCircuitBreaker } from '../services/circuitBreaker.service';
import { killSwitchGate } from '../domain/operatorAction';
import { isProduction } from '../config/environment';
import { collection, getDocs, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { sendCaught, sendError } from '../lib/errors';
import { validateAndEnforceNoPhonePolicy } from '../agents/multiAgentReplySystem';
import { TRUSTED_CTA_REGISTRY } from '../agents/trustedCtaRegistry';
import { runCompleteSalesEngineTestMatrix } from '../agents/salesEngineTestMatrix';

/**
 * S39 — The inbox: conversations, the kill switch, and the reply tooling.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api/inbox`.
 */
export const inboxRouter = Router();

inboxRouter.get('/', async (req: Request, res: Response) => {
  try {
    const snap = await getDocs(collection(store, orgPath(orgScope(req), 'conversations')));
    const items: any[] = [];
    snap.forEach((d: any) => items.push(d.data()));
    res.json(items);
  } catch(e: any) { sendCaught(req, res, e); }
});

inboxRouter.post('/:id/reply', (req: Request, res: Response) => {
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

inboxRouter.post('/:id/classify', (req: Request, res: Response) => {
  // S39 — Was `res.json({ intentConfidence: 0.9 })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Classification on demand is not implemented. This endpoint answered 0.9 for every conversation; intent is classified by the inbound pipeline when a message arrives.');
});

inboxRouter.post('/auto-reply-all', (req: Request, res: Response) => {
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

inboxRouter.get('/sales-decision-engine/inspect', (req: Request, res: Response) => {
  // S39 — Was `res.json({ decision: "Proceed" })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'Live inspection is not implemented. This endpoint answered "Proceed" for every conversation: an unconditional verdict from an engine that was not consulted.');
});

// P0.3 — Was `res.json({ success: true })`: it mutated nothing and returned no
// `circuitBreaker` field, so the console set its state to `undefined` and crashed on the
// next render — during precisely the incident an operator would press it. Now backed by a
// durable, fail-closed service. See server/services/circuitBreaker.service.ts.
inboxRouter.post('/circuit-breaker/toggle', async (req: Request, res: Response) => {
  try {
    const { enabled, reason } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return sendError(req, res, 'VALIDATION_ERROR', '`enabled` must be a boolean.');
    }
    // S6 — Attribution is a state, not a string. This wrote the literal `'unattributed'` into
    // the actor field, which sits in a log looking like an account name. The gate is
    // asymmetric on purpose: a pause is never refused for want of an identity; a resume in
    // production is. See killSwitchGate.
    const gate = killSwitchGate(enabled ? 'RESUME' : 'PAUSE', req.user, isProduction);
    if (gate.allowed === false) {
      return sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);
    }
    const { state, accepted, message, queue } = await setCircuitBreaker(
      enabled,
      reason,
      gate.attribution
    );
    res.json({ success: accepted, message, circuitBreaker: state, queue });
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
inboxRouter.post('/:id/auto-reply', (req: Request, res: Response) => {
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

inboxRouter.post('/:id/memory/refresh', (req: Request, res: Response) => {
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

inboxRouter.post('/:id/follow-up', (req: Request, res: Response) => {
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

inboxRouter.post('/:id/generate-multi-agent-reply', (req: Request, res: Response) => {
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

// Dedicated Phone Policy Validation Tool Endpoint
inboxRouter.post('/validate-phone-policy', (req: Request, res: Response) => {
  try {
    const { text } = req.body;
    const result = validateAndEnforceNoPhonePolicy(text || "");
    res.json(result);
  } catch (error: any) {
    sendCaught(req, res, error);
  }
});

// Canonical CTA Registry Endpoint (Part 21)
inboxRouter.get('/cta-registry', (req: Request, res: Response) => {
  res.json({ success: true, ctaRegistry: TRUSTED_CTA_REGISTRY });
});

// Circuit Breaker Status & Toggle Endpoints (Part 49)
inboxRouter.get('/circuit-breaker', async (req: Request, res: Response) => {
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
inboxRouter.post('/run-test-matrix', async (req: Request, res: Response) => {
  try {
    const report = await runCompleteSalesEngineTestMatrix();
    res.json({ success: true, report });
  } catch (error: any) {
    console.error("Run test matrix error:", error);
    sendCaught(req, res, error);
  }
});
