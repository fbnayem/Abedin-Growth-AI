import type { Request, Response, NextFunction } from 'express';
import { doc, getDoc } from 'firebase/firestore';
import { firestore } from '../firebase';
import { sendError, type ErrorCode } from '../lib/errors';
import {
  attachTenant,
  isValidOrgId,
  orgPath,
  TenantSource,
} from '../tenancy/orgScope';

/**
 * P1.1 — Resolve the tenant for a request, once, from the authenticated user.
 *
 * Runs immediately after `requireAuth`, so `req.user` is a *verified* Firebase token by the
 * time this executes. See server/tenancy/orgScope.ts for why the grant must come from the
 * token and not from Firestore.
 *
 * ORDER OF RESOLUTION
 *   1. `orgId` custom claim            — a single-tenant user.
 *   2. `orgIds` custom claim (array)   — a multi-tenant user; the active tenant is chosen with
 *                                        the `X-Org-Id` header, which must name one of them.
 *                                        With no header and exactly one entry, that entry is
 *                                        used; with no header and several, the request is
 *                                        refused rather than guessed at.
 *   3. DEV_DEFAULT_ORG_ID              — local development only; see below.
 *   4. Refuse.
 *
 * Then, and only as a restriction: if a membership document exists for this user and does not
 * say ACTIVE, the request is refused regardless of what the claim said.
 */

/** Structured refusal, through the one error function. Never leaks the offending value. */
function denyTenant(req: Request, res: Response, code: string, message: string) {
  return sendError(req, res, code as ErrorCode, message, { status: 403 });
}

let devBootstrapWarned = false;

/**
 * The development bootstrap.
 *
 * No user in this project has an `orgId` claim yet — claims are set with the Admin SDK, which
 * needs credentials this repository does not carry (see scripts/set-org-claim.mjs). Without a
 * bootstrap, every endpoint would 403 the moment this middleware lands, which is not a state
 * anyone can develop against.
 *
 * So there is exactly one bootstrap, and it is gated on NODE_ENV. The check is per request,
 * not read once at boot, so setting DEV_DEFAULT_ORG_ID in a production deployment does
 * nothing at all — the same shape as the ALLOW_ANONYMOUS_DEV_AUTH hatch in requireAuth.
 * Requests resolved this way are stamped `DEV_BOOTSTRAP` so audit records can tell them apart
 * from a real grant.
 */
function devBootstrapOrgId(): string | null {
  if (process.env.NODE_ENV === 'production') return null;
  const candidate = process.env.DEV_DEFAULT_ORG_ID;
  if (!candidate) return null;
  if (!isValidOrgId(candidate)) {
    console.error(
      `[tenant] DEV_DEFAULT_ORG_ID=${JSON.stringify(candidate)} is not a valid organisation id; ignoring it.`
    );
    return null;
  }
  if (!devBootstrapWarned) {
    devBootstrapWarned = true;
    console.warn(
      `[tenant] Using DEV_DEFAULT_ORG_ID=${candidate} to resolve tenants. This is a local ` +
        `development bootstrap and is ignored when NODE_ENV=production.`
    );
  }
  return candidate;
}

interface ClaimResolution {
  orgId: string;
  source: TenantSource;
}

type ClaimOutcome =
  | { ok: true; value: ClaimResolution }
  | { ok: false; code: string; message: string };

function resolveFromClaims(req: Request): ClaimOutcome {
  const user: any = req.user ?? {};
  const requested = req.headers['x-org-id'];
  const requestedOrgId = typeof requested === 'string' ? requested.trim() : undefined;

  // 1. Single-tenant claim.
  if (user.orgId !== undefined) {
    if (!isValidOrgId(user.orgId)) {
      return {
        ok: false,
        code: 'TENANT_INVALID',
        message: 'The organisation claim on this credential is not a valid identifier.',
      };
    }
    if (requestedOrgId && requestedOrgId !== user.orgId) {
      return {
        ok: false,
        code: 'TENANT_FORBIDDEN',
        message: 'This credential is not a member of the requested organisation.',
      };
    }
    return { ok: true, value: { orgId: user.orgId, source: 'TOKEN_CLAIM' } };
  }

  // 2. Multi-tenant claim.
  if (Array.isArray(user.orgIds)) {
    const memberships = user.orgIds.filter(isValidOrgId);
    if (memberships.length === 0) {
      return {
        ok: false,
        code: 'TENANT_INVALID',
        message: 'The organisation claims on this credential are not valid identifiers.',
      };
    }
    if (requestedOrgId) {
      // Membership is checked against the SIGNED claim, so the header can only select among
      // organisations the token already grants. It can never introduce a new one.
      if (!memberships.includes(requestedOrgId)) {
        return {
          ok: false,
          code: 'TENANT_FORBIDDEN',
          message: 'This credential is not a member of the requested organisation.',
        };
      }
      return { ok: true, value: { orgId: requestedOrgId, source: 'TOKEN_CLAIM' } };
    }
    if (memberships.length === 1) {
      return { ok: true, value: { orgId: memberships[0], source: 'TOKEN_CLAIM' } };
    }
    // Several memberships and no selection. Picking the first would mean writing a customer
    // record into whichever tenant happened to sort first, which is worse than refusing.
    return {
      ok: false,
      code: 'TENANT_AMBIGUOUS',
      message:
        'This credential belongs to several organisations. Send an X-Org-Id header naming ' +
        'the one to act on.',
    };
  }

  // 3. Development bootstrap.
  const bootstrap = devBootstrapOrgId();
  if (bootstrap) {
    if (requestedOrgId && requestedOrgId !== bootstrap) {
      return {
        ok: false,
        code: 'TENANT_FORBIDDEN',
        message: 'This credential is not a member of the requested organisation.',
      };
    }
    return { ok: true, value: { orgId: bootstrap, source: 'DEV_BOOTSTRAP' } };
  }

  // 4. Refuse. An unresolved tenant is not a default tenant.
  return {
    ok: false,
    code: 'TENANT_UNRESOLVED',
    message:
      'This credential carries no organisation membership. An administrator must grant one ' +
      'before it can read or write organisation data.',
  };
}

export type RevocationOutcome =
  | { revoked: false }
  | { revoked: true; code: 'TENANT_SUSPENDED' | 'TENANT_REVOCATION_UNVERIFIABLE'; message: string };

/**
 * The datastore's only authority over tenancy: it may take access away.
 *
 * An ABSENT membership document is not a denial — most users legitimately have no record,
 * because the claim is the grant. A PRESENT document that does not say ACTIVE is a denial.
 *
 * A read failure is also a denial. That is the §14 rule applied literally: the suspension
 * state is required information, it is unavailable, and unavailable must not resolve to
 * permission. The cost is that a datastore outage locks operators out — acceptable here,
 * because every handler behind this middleware needs that same datastore to do anything.
 */
export async function checkMembershipRevoked(
  orgId: string,
  uid: string
): Promise<RevocationOutcome> {
  if (!firestore) {
    return {
      revoked: true,
      code: 'TENANT_REVOCATION_UNVERIFIABLE',
      message: 'Membership status cannot be verified because the datastore is unavailable.',
    };
  }
  try {
    const snap = await getDoc(doc(firestore, orgPath(orgId, 'members'), uid));
    if (!snap.exists()) return { revoked: false };
    const status = (snap.data() as any)?.status;
    if (status === undefined || status === 'ACTIVE') return { revoked: false };
    return {
      revoked: true,
      code: 'TENANT_SUSPENDED',
      message: 'This membership is not active in the requested organisation.',
    };
  } catch (e: any) {
    console.error(`[tenant] Membership check failed for ${uid}@${orgId}:`, e?.message);
    return {
      revoked: true,
      code: 'TENANT_REVOCATION_UNVERIFIABLE',
      message: 'Membership status cannot be verified.',
    };
  }
}

export const resolveTenant = async (req: Request, res: Response, next: NextFunction) => {
  const user: any = req.user;
  if (!user || !user.uid) {
    // resolveTenant must be mounted after requireAuth. Reaching here without a user means the
    // chain is wired wrong; refusing is the only safe response.
    console.error('[tenant] resolveTenant reached without an authenticated user.');
    return sendError(req, res, 'AUTH_REQUIRED', 'Authentication is required.');
  }

  const outcome = resolveFromClaims(req);
  if (outcome.ok === false) {
    console.warn(`[tenant] ${outcome.code} for uid=${user.uid}: ${outcome.message}`);
    return denyTenant(req, res, outcome.code, outcome.message);
  }

  const { orgId, source } = outcome.value;

  const revocation = await checkMembershipRevoked(orgId, user.uid);
  if (revocation.revoked) {
    console.warn(`[tenant] ${revocation.code} for uid=${user.uid} org=${orgId}`);
    return denyTenant(req, res, revocation.code, revocation.message);
  }

  attachTenant(req, { orgId, source, uid: user.uid });
  return next();
};

/** Exposed for tests: the per-process "warned once" latch. */
export function _resetTenantWarnLatch() {
  devBootstrapWarned = false;
}
