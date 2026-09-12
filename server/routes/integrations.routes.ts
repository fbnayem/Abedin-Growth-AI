import { Router, type Request, type Response } from 'express';
import { isFabricatedProviderId } from '../gateway/actionGateway';
import { collection, getDocs, addDoc, updateDoc, query, where, store } from '../store';
import { orgScope } from '../tenancy/orgScope';
import { sendError } from '../lib/errors';
import { normalizeScopes } from '../lib/capabilities';

/**
 * S39 — Integrations: the Gmail connection, sender identity, LinkedIn.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const integrationsRouter = Router();

integrationsRouter.post('/linkedin/send-message', (req: Request, res: Response) => {
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

integrationsRouter.get('/sender-identity', (req: Request, res: Response) => {
  // S39 — Was `res.json({ name: "AI Agent", email: "agent@example.com" })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'No sender identity is stored. This endpoint returned a fixed placeholder identity; the domain the gateway checks before a send is reported by GET /api/deliverability.');
});

integrationsRouter.post('/sender-identity', (req: Request, res: Response) => {
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

integrationsRouter.get('/linkedin-config', (req: Request, res: Response) => {
  // S39 — Was `res.json({ enabled: true })`: the same answer for every request, which is a
  // fabricated result rather than a stub, and the guardrail could not see it because it
  // looked only for `success: true`.
  sendError(req, res, 'NOT_IMPLEMENTED', 'No LinkedIn configuration is stored. This endpoint reported LinkedIn as enabled while nothing was configured and REAL_LINKEDIN_SEND_ENABLED is false.');
});

integrationsRouter.post('/linkedin-config', (req: Request, res: Response) => {
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

integrationsRouter.post('/integrations/gmail/token', async (req: Request, res: Response) => {
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
