/**
 * WHICH API PATHS MAY BE REACHED WITHOUT A CREDENTIAL.
 *
 * WHAT WAS WRONG, AND WHY THIS IS A MODULE NOW
 * --------------------------------------------
 * P0.4 replaced `req.path.includes('/webhook')` with an exact-path Set. The substring test
 * made every path merely CONTAINING the word unauthenticated — `/api/settings/webhooks` and
 * `/api/campaigns/webhook-preview` among them — and it did so by accident, which is the
 * property that matters: nobody had to decide to open those.
 *
 * The Set was correct and lived inside the server bootstrap function, where nothing could call
 * it. That was fine while every entry was a literal string. S26 needs the unsubscribe route,
 * whose path carries a token and therefore cannot be one — so the allowlist now contains a
 * PATTERN, and a pattern is the exact thing that went wrong before. It moved here so the
 * question "does this admit anything it should not?" can be asked by a test instead of by
 * reading it.
 *
 * THE RULE FOR ADDING A PATTERN
 * -----------------------------
 * Anchored at both ends, and a character class that excludes `/`. Both together are what stop
 * an entry from being widened by appending a segment: `^/unsubscribe/[A-Za-z0-9._-]+$` cannot
 * match `/unsubscribe/x/admin`, and an unanchored or `/`-permitting version could.
 *
 * Every entry here is a surface an anonymous caller can reach, so each needs something that
 * stands in for authentication. For the webhooks that is signature verification; for the
 * unsubscribe route it is the HMAC token in the path.
 */

/** Machine endpoints whose caller cannot hold a user credential. Exact matches only. */
export const UNAUTHENTICATED_API_PATHS = new Set([
  '/readiness',
  '/health',
  '/signature/webhook',
  '/webhooks/gmail',
]);

/**
 * S26 — the unsubscribe endpoint. The only pattern entry, and it names exactly one route.
 *
 * The token is the authorisation: an HMAC over the tenant and contact id, verified with a
 * constant-time comparison before its payload is parsed (`server/domain/unsubscribe.ts`). The
 * caller is a recipient's mail client or their mail provider acting on a one-click
 * unsubscribe, and neither has an account here.
 */
export const UNAUTHENTICATED_API_PATTERNS: readonly RegExp[] = [
  /^\/unsubscribe\/[A-Za-z0-9._-]{1,512}$/,
];

/**
 * Whether a mount-relative API path is reachable without authentication.
 *
 * Takes the already-normalised path rather than the request, so it is a pure function of a
 * string and a test can enumerate the paths an attacker would try.
 */
export function isUnauthenticatedApiPath(path: string): boolean {
  if (UNAUTHENTICATED_API_PATHS.has(path)) return true;
  return UNAUTHENTICATED_API_PATTERNS.some((pattern) => pattern.test(path));
}
