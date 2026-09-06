import { describe, it, expect, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit, _resetRateLimitState } from '../middleware/rateLimit';

/**
 * INVARIANT (addendum §36 / P0.5): expensive and unauthenticated surfaces are bounded.
 *
 * There was no rate limiting of any kind. Combined with the auth fallbacks (P0.4) and the
 * unverified Gmail webhook (P0.14), an anonymous caller could drive unbounded paid Gemini
 * calls — a financial-loss primitive, not a capacity concern.
 */

function mockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res as Response & { statusCode: number; body: any; headers: Record<string, string> };
}

function call(mw: ReturnType<typeof rateLimit>, req: Partial<Request>) {
  const res = mockRes();
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  mw(req as Request, res, next);
  return { res, passed };
}

const ipReq = (ip: string) => ({ ip, socket: { remoteAddress: ip }, headers: {} }) as any;

beforeEach(() => {
  _resetRateLimitState();
});

describe('§36 — the limit is actually enforced', () => {
  it('permits exactly `max` requests then rejects the next one', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 5 });
    const req = ipReq('1.1.1.1');

    for (let i = 0; i < 5; i++) {
      const { passed } = call(mw, req);
      expect(passed, `request ${i + 1} should pass`).toBe(true);
    }

    const { passed, res } = call(mw, req);
    expect(passed).toBe(false);
    expect(res.statusCode).toBe(429);
  });

  it('returns a STRUCTURED error, not prose the client must parse', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 1 });
    const req = ipReq('2.2.2.2');
    call(mw, req);
    const { res } = call(mw, req);

    expect(res.body.error.code).toBe('PROVIDER_RATE_LIMITED');
    expect(res.body.error.retryable).toBe(true);
    expect(typeof res.body.error.retryAfterSeconds).toBe('number');
  });

  it('sets Retry-After and the standard rate-limit headers', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 1 });
    const req = ipReq('3.3.3.3');
    const first = call(mw, req);
    expect(first.res.headers['X-RateLimit-Limit']).toBe('1');
    expect(first.res.headers['X-RateLimit-Remaining']).toBe('0');

    const second = call(mw, req);
    expect(second.res.headers['Retry-After']).toBeDefined();
  });
});

describe('§36 — budgets are per-caller, and cannot be escaped', () => {
  it('tracks separate budgets per IP', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 2 });
    call(mw, ipReq('10.0.0.1'));
    call(mw, ipReq('10.0.0.1'));
    expect(call(mw, ipReq('10.0.0.1')).passed).toBe(false);

    // A different caller is unaffected by the first one's exhaustion.
    expect(call(mw, ipReq('10.0.0.2')).passed).toBe(true);
  });

  it('keys an AUTHENTICATED caller by uid, so rotating IPs does not reset the budget', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 2 });
    const asUser = (ip: string) =>
      ({ ip, socket: { remoteAddress: ip }, headers: {}, user: { uid: 'u1' } }) as any;

    call(mw, asUser('10.0.0.1'));
    call(mw, asUser('10.0.0.2'));
    // Third request from yet another IP must still be refused: the identity is the key.
    expect(call(mw, asUser('10.0.0.3')).passed).toBe(false);
  });

  it('separate limiters keep separate budgets', () => {
    const general = rateLimit({ name: 'api', windowMs: 60_000, max: 1 });
    const ai = rateLimit({ name: 'ai', windowMs: 60_000, max: 1 });
    const req = ipReq('4.4.4.4');

    expect(call(general, req).passed).toBe(true);
    expect(call(general, req).passed).toBe(false);
    // Exhausting the general budget must not pre-consume the AI budget.
    expect(call(ai, req).passed).toBe(true);
  });
});

describe('§36 — the window resets', () => {
  it('allows requests again once the window has elapsed', async () => {
    const mw = rateLimit({ name: 'test', windowMs: 30, max: 1 });
    const req = ipReq('5.5.5.5');

    expect(call(mw, req).passed).toBe(true);
    expect(call(mw, req).passed).toBe(false);

    await new Promise((r) => setTimeout(r, 45));
    expect(call(mw, req).passed).toBe(true);
  });
});

describe('§36 — unattributable callers are still bounded', () => {
  it('falls back to a stable key when neither user nor IP is present', () => {
    const mw = rateLimit({ name: 'test', windowMs: 60_000, max: 2 });
    const anon = { headers: {}, socket: {} } as any;

    expect(call(mw, anon).passed).toBe(true);
    expect(call(mw, anon).passed).toBe(true);
    // Crucially it does NOT create a fresh bucket each time, which would mean no limit at all.
    expect(call(mw, anon).passed).toBe(false);
  });
});
