import type { Request } from 'express';

/**
 * P1.1 — TENANT RESOLUTION.
 *
 * WHAT WAS WRONG
 * --------------
 * There was no tenant. One hardcoded organisation id appeared 42 times across seven files — in
 * Firestore collection paths, in the action gateway, in the outbox queue, in the kill switch
 * — and every one of them was a literal. Nothing in the request pipeline ever asked *which*
 * organisation a caller belonged to, so:
 *
 *   - Every authenticated user read and wrote the same tenant's data, whoever they were.
 *   - Two services (`identityResolver.resolve`, `inboundPipeline.processNewEmail`) accepted an
 *     `organizationId` argument and dropped it on the floor; their queries had no tenant
 *     predicate at all.
 *   - `actionGateway.ts` hardcoded another tenant's contacts collection for the consent lookup while
 *     `request.organizationId` sat in scope nine lines away — so a consent check for tenant B
 *     was answered from tenant A's contact records.
 *
 * This module is the single place that answers "which organisation is this?", and `orgPath()`
 * is the single place that turns that answer into a datastore path.
 *
 * WHERE THE ANSWER COMES FROM — AND WHY IT IS NOT THE DATASTORE
 * ------------------------------------------------------------
 * The grant comes from a Firebase custom claim on the verified ID token. Custom claims can
 * only be written with Admin SDK credentials, and they are covered by the token signature, so
 * a claim is a statement the server made about the user and can trust.
 *
 * Membership documents in Firestore are NOT a grant. `firestore.rules` is still
 * `allow read, write: if true` (P0.0, outstanding and not mine to fix), which makes every
 * collection world-writable; a membership record read from there could have been written by
 * anyone. So the same asymmetric-authority rule used for the kill switch applies here:
 *
 *     the environment and the signed token may GRANT; the datastore may only REVOKE.
 *
 * A membership document can therefore take access away (suspension) but can never confer it.
 *
 * PATH INJECTION
 * --------------
 * Once the org id stops being a literal and starts coming from a token, it becomes untrusted
 * input that is concatenated into a Firestore path. `collection(db, 'organizations/' + orgId +
 * '/contacts')` splits on `/`, so an org id of `a/contacts` or `../../oauth_connections`
 * silently retargets the read. `assertValidOrgId` is what stops that, and `orgPath` is the
 * only sanctioned way to build these paths precisely so the check cannot be skipped.
 */

/**
 * Deliberately narrow: alphanumerics, hyphen and underscore, first character alphanumeric,
 * 1-64 characters. No dots (`..`), no slashes (path segments), no whitespace, no percent
 * escapes. This is an allow-list, not a deny-list, because a deny-list of dangerous path
 * constructs is exactly the kind of thing that gets bypassed by the next encoding.
 */
export const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** How the org id was established. Recorded so audit entries can distinguish real grants. */
export type TenantSource = 'TOKEN_CLAIM' | 'DEV_BOOTSTRAP';

export interface TenantContext {
  orgId: string;
  source: TenantSource;
  uid: string;
}

/**
 * Thrown when `orgScope(req)` is called on a request that never passed through
 * `resolveTenant`. This is a routing/wiring mistake in the server, not a client error: the
 * middleware denies unresolved callers with a 403 before a handler ever runs, so reaching a
 * handler without a tenant means the route was mounted outside the tenant-resolving chain.
 */
export class TenantUnresolvedError extends Error {
  readonly code = 'TENANT_UNRESOLVED';
  constructor(message: string) {
    super(message);
    this.name = 'TenantUnresolvedError';
  }
}

export class InvalidOrgIdError extends Error {
  readonly code = 'TENANT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrgIdError';
  }
}

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

/**
 * Validate and return an org id, or throw. Every path built from an org id goes through this.
 */
export function assertValidOrgId(candidate: unknown): string {
  if (typeof candidate !== 'string') {
    throw new InvalidOrgIdError(
      `Organisation id must be a string; received ${candidate === null ? 'null' : typeof candidate}.`
    );
  }
  if (!ORG_ID_PATTERN.test(candidate)) {
    // The offending value is deliberately not echoed back to the caller by the middleware;
    // it is included here for the server log only.
    throw new InvalidOrgIdError(
      `Organisation id ${JSON.stringify(candidate)} is not a valid identifier. ` +
        `Expected 1-64 characters matching ${ORG_ID_PATTERN}.`
    );
  }
  return candidate;
}

export function isValidOrgId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && ORG_ID_PATTERN.test(candidate);
}

/**
 * Build a tenant-scoped datastore path. The ONLY sanctioned way to address tenant data.
 *
 *   orgPath('acme', 'contacts')                      -> 'organizations/acme/contacts'
 *   orgPath('acme', 'conversations', id, 'messages') -> 'organizations/acme/conversations/<id>/messages'
 *
 * Every segment is validated too: a conversation id or contact id reaching this function is
 * usually a URL parameter, which is no more trustworthy than the org id.
 */
export function orgPath(orgId: string, ...segments: string[]): string {
  const org = assertValidOrgId(orgId);
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment.length === 0) {
      throw new InvalidOrgIdError('Path segments must be non-empty strings.');
    }
    if (segment.includes('/') || segment === '.' || segment === '..') {
      throw new InvalidOrgIdError(
        `Path segment ${JSON.stringify(segment)} would change the shape of the path.`
      );
    }
  }
  return ['organizations', org, ...segments].join('/');
}

/** Attach a resolved tenant to a request. Called only by `resolveTenant`. */
export function attachTenant(req: Request, context: TenantContext): void {
  req.tenant = {
    orgId: assertValidOrgId(context.orgId),
    source: context.source,
    uid: context.uid,
  };
}

/** The resolved tenant, or null. Use when absence is a legitimate outcome. */
export function tryOrgScope(req: Request): TenantContext | null {
  return req.tenant ?? null;
}

/** The full resolved tenant context. Throws if the request was never resolved. */
export function orgContext(req: Request): TenantContext {
  const tenant = req.tenant;
  if (!tenant) {
    throw new TenantUnresolvedError(
      'No tenant on this request. The route was reached without passing through ' +
        'resolveTenant(); mount it inside the tenant-resolving middleware chain.'
    );
  }
  return tenant;
}

/**
 * The org id for this request. This is the accessor handlers should use.
 *
 * It throws rather than returning a default, which is the entire point: a handler that
 * silently fell back to some default organisation is how the 42 hardcoded literals came to
 * exist in the first place.
 */
export function orgScope(req: Request): string {
  return orgContext(req).orgId;
}
