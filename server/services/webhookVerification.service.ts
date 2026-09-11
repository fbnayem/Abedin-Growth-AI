import crypto from 'crypto';
import type { Request } from 'express';

/**
 * P0.14 — Webhook authenticity verification.
 *
 * These endpoints are exempt from `requireAuth` because the caller is a machine that cannot
 * hold a user credential (see the allowlist in server.ts). That makes signature verification
 * the ONLY thing standing between them and an anonymous caller on the internet.
 *
 * Every function here FAILS CLOSED. If a secret is not configured, verification does not
 * "skip" — it fails. An unverifiable webhook is refused, because the alternative is an
 * unauthenticated endpoint that mutates meeting state or drives a paid AI loop.
 */

/**
 * A verdict, or the reason there is not one.
 *
 * `{ ok: boolean; reason?: string }` could not be narrowed: after `if (!verification.ok)` the
 * reason was still `string | undefined`, so each refusal handed `sendError` a message its type
 * said might be missing. `reason?: undefined` on the success arm keeps `.reason` readable on the
 * union without narrowing first.
 */
export type VerificationResult =
  | { readonly ok: true; readonly reason?: undefined }
  | { readonly ok: false; readonly reason: string };

/**
 * Constant-time comparison. A plain `===` on a signature leaks its contents through timing,
 * letting an attacker recover a valid signature byte by byte.
 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length. Compare a
  // fixed-size digest of each side instead, so every comparison costs the same.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * DocuSign Connect HMAC. DocuSign signs the raw request body with a shared secret and sends
 * base64 HMAC-SHA256 in `x-docusign-signature-1`.
 *
 * `rawBody` must be the exact bytes received. If it has already been through a JSON parser
 * and re-serialised, the signature will not match — which is the defect this fixes.
 */
export function verifyDocuSignSignature(req: Request, rawBody: Buffer | undefined): VerificationResult {
  const secret = process.env.DOCUSIGN_WEBHOOK_SECRET;
  if (!secret) {
    return {
      ok: false,
      reason:
        'DOCUSIGN_WEBHOOK_SECRET is not configured. Refusing the request rather than ' +
        'accepting an unverified webhook.',
    };
  }
  if (!rawBody || !Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    return {
      ok: false,
      reason:
        'Raw request body unavailable. express.raw() must be mounted before express.json() ' +
        'for this path, or the signature cannot be computed over the original bytes.',
    };
  }

  const provided =
    (req.headers['x-docusign-signature-1'] as string | undefined) ||
    (req.headers['x-authorization-signature-sha256'] as string | undefined);

  if (!provided) {
    return { ok: false, reason: 'Missing DocuSign signature header.' };
  }

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  if (!timingSafeEqualStr(provided.trim(), expected)) {
    return { ok: false, reason: 'DocuSign signature mismatch.' };
  }
  return { ok: true };
}

/**
 * Google Pub/Sub push verification via a shared verification token.
 *
 * Pub/Sub push subscriptions can carry a secret, either as a query parameter on the push
 * endpoint URL or as an OIDC bearer token. Full OIDC validation requires fetching and caching
 * Google's rotating public keys, which needs a dependency this project does not carry; a
 * shared token configured on the subscription is a legitimate, widely-used alternative and is
 * far stronger than the current state, which is no verification at all.
 *
 * If you later add google-auth-library, replace this with OidcClient verification of the
 * Authorization bearer against the expected audience and issuer.
 */
export function verifyPubSubToken(req: Request): VerificationResult {
  const expected = process.env.GMAIL_PUBSUB_VERIFICATION_TOKEN;
  if (!expected) {
    return {
      ok: false,
      reason:
        'GMAIL_PUBSUB_VERIFICATION_TOKEN is not configured. Refusing the request rather than ' +
        'exposing an unauthenticated endpoint that drives a paid AI processing loop.',
    };
  }

  const fromQuery = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const authHeader = req.headers.authorization;
  const fromBearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  const provided = fromQuery || fromBearer;

  if (!provided) {
    return { ok: false, reason: 'Missing Pub/Sub verification token.' };
  }
  if (!timingSafeEqualStr(provided.trim(), expected)) {
    return { ok: false, reason: 'Pub/Sub verification token mismatch.' };
  }
  return { ok: true };
}
