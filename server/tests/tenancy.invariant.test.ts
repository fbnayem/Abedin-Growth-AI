import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * INVARIANTS (addendum §4, §14, §26 / P1.1).
 *
 * §4  Every read and write is scoped to exactly one tenant, and the tenant comes from the
 *     authenticated caller — not from a literal, not from a request body, not from a default.
 * §14 Unknown state must never resolve to permission. An unresolved tenant is not a tenant.
 * §26 A control's authority must be asymmetric where the store is untrusted: the signed token
 *     may grant, the world-writable datastore may only take away.
 *
 * Before P1.1 there was no tenant at all: 42 occurrences of one hardcoded organisation id
 * across seven files. These tests exist because "it compiles and the endpoint returns 200" was
 * equally true of the version that served every caller the same tenant's data.
 */

let membershipDocs: Record<string, any> = {};
let membershipShouldThrow = false;
let storeAvailable = true;


vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
  },
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}` }),
  getDoc: async (ref: any) => {
    if (membershipShouldThrow) throw new Error('datastore unavailable');
    const exists = Object.prototype.hasOwnProperty.call(membershipDocs, ref.path);
    return {
      exists: () => exists,
      data: () => (exists ? membershipDocs[ref.path] : undefined),
    };
  },
}));

const { assertValidOrgId, isValidOrgId, orgPath, orgScope, attachTenant } = await import(
  '../tenancy/orgScope'
);
const { resolveTenant, checkMembershipRevoked } = await import('../middleware/tenant');

// ---------------------------------------------------------------------------
// Test doubles for the Express surface. Deliberately minimal: what matters is the status
// code and the error code, which is exactly what a caller sees.
// ---------------------------------------------------------------------------
interface Captured {
  status?: number;
  body?: any;
  nextCalled: boolean;
}

function makeRes(captured: Captured) {
  return {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  } as any;
}

async function run(req: any): Promise<Captured> {
  const captured: Captured = { nextCalled: false };
  await resolveTenant(req, makeRes(captured), () => {
    captured.nextCalled = true;
  });
  return captured;
}

const req = (over: any = {}) => ({ headers: {}, user: { uid: 'u1' }, ...over });

beforeEach(() => {
  membershipDocs = {};
  membershipShouldThrow = false;
  storeAvailable = true;
  delete process.env.DEV_DEFAULT_ORG_ID;
  delete process.env.NODE_ENV;
});

// ---------------------------------------------------------------------------
describe('§4 — an org id can never change the shape of a datastore path', () => {
  // The org id stopped being a literal and became token-supplied input that is concatenated
  // into a Firestore path. Firestore splits paths on '/', so an unvalidated id retargets the
  // read to a collection of the caller's choosing.
  const attacks = [
    '../oauth_connections',
    'acme/../globex',
    'acme/contacts',
    '..',
    '.',
    '',
    'a'.repeat(65),
    'acme id',
    'acme' + String.fromCharCode(0), // NUL: truncation tricks in path handlers
    'acme ',                            // trailing space
    '-leading-hyphen',
  ];

  for (const attack of attacks) {
    it(`REJECTS ${JSON.stringify(attack)}`, () => {
      expect(isValidOrgId(attack)).toBe(false);
      expect(() => assertValidOrgId(attack)).toThrow();
      expect(() => orgPath(attack, 'contacts')).toThrow();
    });
  }

  it('rejects non-strings rather than coercing them', () => {
    for (const value of [null, undefined, 42, {}, ['acme']]) {
      expect(() => assertValidOrgId(value)).toThrow();
    }
  });

  it('accepts ordinary identifiers', () => {
    for (const value of ['acme', 'org-1', 'Org_2', 'a']) {
      expect(assertValidOrgId(value)).toBe(value);
    }
  });

  it('builds the expected path', () => {
    expect(orgPath('acme', 'contacts')).toBe('organizations/acme/contacts');
    expect(orgPath('acme', 'conversations', 'c1', 'messages')).toBe(
      'organizations/acme/conversations/c1/messages'
    );
  });

  it('validates every segment, not just the org id', () => {
    // Conversation and contact ids reaching orgPath are usually URL parameters.
    expect(() => orgPath('acme', 'conversations', '../../oauth_connections')).toThrow();
    expect(() => orgPath('acme', '')).toThrow();
    expect(() => orgPath('acme', '..')).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('§14 — an unresolved tenant is not a default tenant', () => {
  it('THROWS rather than returning a default when the request was never resolved', () => {
    // The whole failure this replaces was a silent default. orgScope must have no fallback.
    expect(() => orgScope({} as any)).toThrow(/No tenant on this request/);
  });

  it('returns the attached tenant once resolved', () => {
    const r: any = {};
    attachTenant(r, { orgId: 'acme', source: 'TOKEN_CLAIM', uid: 'u1' });
    expect(orgScope(r)).toBe('acme');
  });

  it('refuses to attach an invalid org id', () => {
    expect(() =>
      attachTenant({} as any, { orgId: '../evil', source: 'TOKEN_CLAIM', uid: 'u1' })
    ).toThrow();
  });

  it('DENIES a caller whose credential carries no organisation', async () => {
    const captured = await run(req());
    expect(captured.nextCalled).toBe(false);
    expect(captured.status).toBe(403);
    expect(captured.body.error.code).toBe('TENANT_UNRESOLVED');
  });

  it('DENIES rather than picking one when a caller belongs to several', async () => {
    const captured = await run(req({ user: { uid: 'u1', orgIds: ['acme', 'globex'] } }));
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_AMBIGUOUS');
  });

  it('DENIES when the middleware is reached without an authenticated user', async () => {
    const captured = await run({ headers: {} });
    expect(captured.nextCalled).toBe(false);
    expect(captured.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('§4 — the header selects among granted tenants; it never grants one', () => {
  it('allows selecting an organisation the token already grants', async () => {
    const captured = await run(
      req({ user: { uid: 'u1', orgIds: ['acme', 'globex'] }, headers: { 'x-org-id': 'globex' } })
    );
    expect(captured.nextCalled).toBe(true);
  });

  it('REFUSES an organisation the token does not grant', async () => {
    const captured = await run(
      req({ user: { uid: 'u1', orgIds: ['acme'] }, headers: { 'x-org-id': 'globex' } })
    );
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_FORBIDDEN');
  });

  it('REFUSES to override a single-tenant claim', async () => {
    const captured = await run(
      req({ user: { uid: 'u1', orgId: 'acme' }, headers: { 'x-org-id': 'globex' } })
    );
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_FORBIDDEN');
  });

  it('REFUSES a claim that is not a valid identifier', async () => {
    const captured = await run(req({ user: { uid: 'u1', orgId: '../oauth_connections' } }));
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_INVALID');
  });

  it('resolves a single-tenant claim', async () => {
    const r = req({ user: { uid: 'u1', orgId: 'acme' } });
    const captured = await run(r);
    expect(captured.nextCalled).toBe(true);
    expect(r.tenant).toEqual({ orgId: 'acme', source: 'TOKEN_CLAIM', uid: 'u1' });
  });
});

// ---------------------------------------------------------------------------
describe('§A — the development bootstrap cannot exist in production', () => {
  it('resolves from DEV_DEFAULT_ORG_ID outside production', async () => {
    process.env.DEV_DEFAULT_ORG_ID = 'acme';
    const r = req();
    const captured = await run(r);
    expect(captured.nextCalled).toBe(true);
    // Stamped, so an audit record can tell a bootstrap from a real grant.
    expect(r.tenant.source).toBe('DEV_BOOTSTRAP');
  });

  it('IGNORES DEV_DEFAULT_ORG_ID when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_DEFAULT_ORG_ID = 'acme';
    const captured = await run(req());
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_UNRESOLVED');
  });

  it('IGNORES a DEV_DEFAULT_ORG_ID that is not a valid identifier', async () => {
    process.env.DEV_DEFAULT_ORG_ID = '../oauth_connections';
    const captured = await run(req());
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_UNRESOLVED');
  });

  it('does not let the header escape the bootstrap organisation', async () => {
    process.env.DEV_DEFAULT_ORG_ID = 'acme';
    const captured = await run(req({ headers: { 'x-org-id': 'globex' } }));
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
describe('§26 — the datastore may revoke, never grant', () => {
  it('does NOT grant access from a membership document alone', async () => {
    // firestore.rules is still `allow read, write: if true` (P0.0), so anyone can write a
    // membership record. Writing one must not create access.
    membershipDocs['organizations/acme/members/u1'] = { status: 'ACTIVE' };
    const captured = await run(req()); // no claim
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_UNRESOLVED');
  });

  it('REVOKES access when a membership document says the member is not active', async () => {
    membershipDocs['organizations/acme/members/u1'] = { status: 'SUSPENDED' };
    const captured = await run(req({ user: { uid: 'u1', orgId: 'acme' } }));
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_SUSPENDED');
  });

  it('allows a valid claim when no membership document exists', async () => {
    const captured = await run(req({ user: { uid: 'u1', orgId: 'acme' } }));
    expect(captured.nextCalled).toBe(true);
  });

  it('FAILS CLOSED when membership status cannot be read', async () => {
    membershipShouldThrow = true;
    const captured = await run(req({ user: { uid: 'u1', orgId: 'acme' } }));
    expect(captured.nextCalled).toBe(false);
    expect(captured.body.error.code).toBe('TENANT_REVOCATION_UNVERIFIABLE');
  });

  it('FAILS CLOSED when the datastore is unavailable entirely', async () => {
    storeAvailable = false;
    const outcome = await checkMembershipRevoked('acme', 'u1');
    expect(outcome.revoked).toBe(true);
  });

  it('scopes the membership lookup to the resolved organisation', async () => {
    // A suspension in one organisation must not lock the user out of another.
    membershipDocs['organizations/globex/members/u1'] = { status: 'SUSPENDED' };
    const captured = await run(req({ user: { uid: 'u1', orgId: 'acme' } }));
    expect(captured.nextCalled).toBe(true);
  });
});
