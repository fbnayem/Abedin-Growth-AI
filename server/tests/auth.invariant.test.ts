import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

/**
 * INVARIANT (addendum §4 / P0.4): authentication FAILS CLOSED.
 *
 * The middleware previously had three ways to admit an unauthenticated caller:
 *   1. no Authorization header      -> req.user = { uid: "preview_uid" }, next()
 *   2. the literal token "demo_bary" -> a named user session from a string constant
 *   3. firebaseAuth failing to init  -> EVERY token accepted without verification
 *
 * (3) is the worst: Firebase init is wrapped in a try/catch that only logs, so a
 * misconfigured deployment degrades silently from "verifies tokens" to "accepts anything".
 *
 * The Firebase module is mocked so these tests exercise the middleware's decision logic
 * without needing real credentials.
 */

const ORIGINAL = { ...process.env };

// Controlled by each test to simulate Firebase being available or not.
let mockAuth: { verifyIdToken: (t: string) => Promise<any> } | null = null;

vi.mock('../firebase', () => ({
  get firebaseAuth() {
    return mockAuth;
  },
  firestore: null,
}));

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any };
}

async function runAuth(headers: Record<string, string> = {}) {
  const { requireAuth } = await import('../middleware/auth');
  const req = { headers } as unknown as Request;
  const res = mockRes();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  await requireAuth(req, res, next);
  return { req, res, nextCalled };
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.ALLOW_ANONYMOUS_DEV_AUTH;
  process.env.NODE_ENV = 'test';
  mockAuth = { verifyIdToken: async () => ({ uid: 'real_user', email: 'real@example.com' }) };
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('§4 — no credential means no access', () => {
  it('rejects a request with no Authorization header', async () => {
    const { res, nextCalled } = await runAuth();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('rejects a non-Bearer Authorization header', async () => {
    const { res, nextCalled } = await runAuth({ authorization: 'Basic dXNlcjpwYXNz' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('rejects an empty Bearer token', async () => {
    const { res, nextCalled } = await runAuth({ authorization: 'Bearer ' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe('§4 — the hardcoded backdoor is gone', () => {
  it('does NOT grant a session for the literal token "demo_bary"', async () => {
    // Regression guard for a credential that was committed to a public repository.
    mockAuth = {
      verifyIdToken: async () => {
        throw new Error('not a real token');
      },
    };
    const { req, res, nextCalled } = await runAuth({ authorization: 'Bearer demo_bary' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect((req as any).user).toBeUndefined();
  });
});

describe('§4 — an unverifiable server refuses rather than assumes', () => {
  it('returns 503 when Firebase Auth is unavailable, instead of accepting the token', async () => {
    // The dangerous old behaviour: `if (!firebaseAuth) { req.user = ...; return next(); }`
    mockAuth = null;
    const { req, res, nextCalled } = await runAuth({ authorization: 'Bearer any-token-at-all' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('AUTH_UNAVAILABLE');
    expect((req as any).user).toBeUndefined();
  });

  it('rejects a token the verifier refuses', async () => {
    mockAuth = {
      verifyIdToken: async () => {
        throw new Error('expired');
      },
    };
    const { res, nextCalled } = await runAuth({ authorization: 'Bearer expired-token' });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID');
  });

  it('admits a caller whose token verifies, attaching the decoded identity', async () => {
    const { req, nextCalled } = await runAuth({ authorization: 'Bearer good-token' });
    expect(nextCalled).toBe(true);
    expect((req as any).user.uid).toBe('real_user');
  });
});

describe('§4 — the dev escape hatch cannot be opened in production', () => {
  it('admits an anonymous caller when the hatch is open and NODE_ENV is not production', async () => {
    process.env.ALLOW_ANONYMOUS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    const { req, nextCalled } = await runAuth();
    expect(nextCalled).toBe(true);
    expect((req as any).user.isAnonymousDevUser).toBe(true);
  });

  it('IGNORES the hatch when NODE_ENV is production', async () => {
    // The property that makes the hatch acceptable: setting it in production does nothing.
    process.env.ALLOW_ANONYMOUS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    const { res, nextCalled } = await runAuth();
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('requires the exact string "true" — the hatch also fails closed', async () => {
    process.env.NODE_ENV = 'development';
    for (const value of ['1', 'yes', 'TRUE', '']) {
      process.env.ALLOW_ANONYMOUS_DEV_AUTH = value;
      const { res, nextCalled } = await runAuth();
      expect(nextCalled).toBe(false);
      expect(res.statusCode).toBe(401);
    }
  });

  it('marks the dev identity so audit records can distinguish it from a real operator', async () => {
    process.env.ALLOW_ANONYMOUS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    const { req } = await runAuth();
    expect((req as any).user.isAnonymousDevUser).toBe(true);
    expect((req as any).user.uid).not.toBe('preview_uid');
  });
});
