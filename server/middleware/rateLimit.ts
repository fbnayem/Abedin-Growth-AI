import { Request, Response, NextFunction } from 'express';

/**
 * P0.5 — Tiered rate limiting.
 *
 * WHAT WAS WRONG
 * --------------
 * There was no rate limiting of any kind. Combined with the auth fallbacks fixed in P0.4 and
 * the unverified Gmail webhook fixed in P0.14, an anonymous caller could drive unbounded paid
 * Gemini calls. That is an open financial-loss primitive, not an "operational maturity" gap,
 * which is why this moved from P3 into P0.
 *
 * SCOPE AND HONESTY ABOUT IT
 * --------------------------
 * This limiter keeps counters in process memory. That is correct for a single instance and
 * genuinely closes the anonymous-spend hole, but it does NOT coordinate across replicas: two
 * instances each permit the configured budget. A shared store (Redis) is required before this
 * can be called complete, and REDIS_URL is already listed in the external-setup document.
 * The limiter is deliberately written so the store can be swapped without touching call sites.
 *
 * Memory is bounded: expired buckets are swept on write, so a flood of distinct keys cannot
 * grow the map without limit.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = 0;

function sweep(now: number) {
  // Sweep at most once a second; O(n) over buckets, which stays small in practice.
  if (now - lastSweep < 1000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per key per window. */
  max: number;
  /** Label used in logs and in the error payload. */
  name: string;
  /**
   * Derives the bucket key. Defaults to authenticated user, else organization, else IP —
   * so an authenticated caller cannot escape their budget by rotating source addresses, and
   * an unauthenticated one is still bounded.
   */
  keyBy?: (req: Request) => string;
}

function defaultKey(req: Request): string {
  // P1.1 — The organisation now comes from req.tenant, set by resolveTenant. The previous
  // `user.organizationId` branch could never fire: a Firebase decoded token has no such
  // field, so the org tier of this limiter was dead code.
  //
  // Budgets are per (tenant, user) rather than per user, so one tenant cannot consume
  // another tenant's allowance through a shared operator account.
  const tenant = (req as any).tenant;
  const user = (req as any).user;
  if (user?.uid) return tenant?.orgId ? `u:${tenant.orgId}:${user.uid}` : `u:${user.uid}`;
  if (tenant?.orgId) return `o:${tenant.orgId}`;
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, name, keyBy = defaultKey } = opts;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);

    const key = `${name}:${keyBy(req)}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      console.warn(`[rateLimit] ${name} limit exceeded for ${key} (${bucket.count}/${max})`);
      // Structured error, per the S12 envelope, so clients branch on a code rather than prose.
      return res.status(429).json({
        error: {
          code: 'PROVIDER_RATE_LIMITED',
          message: `Rate limit exceeded for ${name}. Retry in ${retryAfter}s.`,
          retryable: true,
          retryAfterSeconds: retryAfter,
        },
      });
    }

    return next();
  };
}

/** Ordinary reads. Generous — this exists to stop runaway clients, not to shape traffic. */
export const standardApiLimiter = rateLimit({
  name: 'api',
  windowMs: 60_000,
  max: 300,
});

/**
 * Expensive AI generation. Deliberately far tighter: each request behind this can fan out into
 * multiple model calls, so the blast radius of a loop here is measured in currency.
 */
export const aiOperationLimiter = rateLimit({
  name: 'ai',
  windowMs: 60_000,
  max: 20,
});

/**
 * Unauthenticated machine endpoints (webhooks). Keyed by IP because there is no user. Sized
 * for legitimate provider retry behaviour, not for a caller trying to drive work.
 */
export const webhookLimiter = rateLimit({
  name: 'webhook',
  windowMs: 60_000,
  max: 120,
  keyBy: (req) => `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`,
});

/** Exposed for tests and for operational inspection. */
export function _resetRateLimitState() {
  buckets.clear();
  lastSweep = 0;
}
