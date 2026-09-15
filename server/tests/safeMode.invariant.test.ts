import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isRealActionEnabled,
  safeModeSnapshot,
  isFullySafeMode,
  REAL_ACTION_FLAGS,
} from '../config/safeMode';

/**
 * INVARIANT (addendum §A / §46): production action flags must FAIL CLOSED.
 *
 * Two defects motivated these tests:
 *
 * 1. The ActionGateway snapshotted flags into a class field at module-evaluation time, which
 *    ES module hoisting runs before server.ts's `dotenv.config()`. Values in .env never
 *    reached the enforcement point, while /api/readiness read process.env at request time —
 *    so the flag an operator SAW and the flag the system ENFORCED were different reads.
 *    These tests pin the lazy behaviour that fixed it: changing the environment changes the
 *    answer on the next call, with no stale copy to diverge.
 *
 * 2. `checkFeatureFlag` had `default: return true`, so any unrecognised action type was
 *    dispatched by default — a gate that failed OPEN.
 */

const ORIGINAL = { ...process.env };

beforeEach(() => {
  for (const f of REAL_ACTION_FLAGS) delete process.env[f];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('§A — Safe Mode flags fail closed', () => {
  it('an absent flag is DISABLED', () => {
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(false);
  });

  it.each([
    ['', 'empty string'],
    ['TRUE', 'uppercase'],
    ['True', 'title case'],
    ['1', 'numeric one'],
    ['yes', 'yes'],
    ['on', 'on'],
    ['true ', 'trailing space'],
    [' true', 'leading space'],
    ['truthy', 'superstring'],
  ])('the value %j (%s) does NOT enable the action', (value) => {
    process.env.REAL_EMAIL_SEND_ENABLED = value as string;
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(false);
  });

  it('ONLY the exact string "true" enables an action', () => {
    process.env.REAL_EMAIL_SEND_ENABLED = 'true';
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(true);
  });

  it('each flag is independent — enabling email does not enable payments', () => {
    process.env.REAL_EMAIL_SEND_ENABLED = 'true';
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(true);
    expect(isRealActionEnabled('REAL_PAYMENT_ENABLED')).toBe(false);
    expect(isRealActionEnabled('REAL_CALENDAR_CREATE_ENABLED')).toBe(false);
    expect(isRealActionEnabled('REAL_SIGNATURE_ENABLED')).toBe(false);
    expect(isRealActionEnabled('REAL_LINKEDIN_SEND_ENABLED')).toBe(false);
  });
});

describe('§46 — flags are read lazily, so display and enforcement cannot diverge', () => {
  it('reflects an environment change WITHOUT re-importing the module', () => {
    // This is the regression test for the module-evaluation snapshot. Under the old design
    // the value was frozen at import; here the second read must see the new value.
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(false);
    process.env.REAL_EMAIL_SEND_ENABLED = 'true';
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(true);
    process.env.REAL_EMAIL_SEND_ENABLED = 'false';
    expect(isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')).toBe(false);
  });

  it('every flag in the snapshot is reported by /api/readiness', () => {
    // The aggregate and the per-flag view must not disagree about what the aggregate covers.
    // `allExternalActionsDisabled` already counted discovery and scraping before the readiness
    // handler listed them, so an operator reading five booleans beside a claim covering seven
    // had no way to see the other two.
    // Comments stripped first: the handler's own comment names the aggregate, so slicing to
    // the first mention of it would end the block inside the prose rather than at the field.
    const handler = readFileSync('server/routes/health.routes.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const block = handler.slice(handler.indexOf('safeRebuildMode: {'), handler.indexOf('allExternalActionsDisabled'));
    for (const flag of REAL_ACTION_FLAGS) {
      expect(block, flag).toContain(`flags.${flag}`);
    }
  });

  it('safeModeSnapshot() agrees with isRealActionEnabled() for every flag', () => {
    // readiness renders the snapshot; the gateway calls isRealActionEnabled. If these two
    // ever disagree, the operator-facing indicator is lying again.
    process.env.REAL_EMAIL_SEND_ENABLED = 'true';
    process.env.REAL_PAYMENT_ENABLED = 'true';

    const snapshot = safeModeSnapshot();
    for (const flag of REAL_ACTION_FLAGS) {
      expect(snapshot[flag]).toBe(isRealActionEnabled(flag));
    }
  });

  it('the snapshot covers every declared flag — no flag can be silently omitted', () => {
    const snapshot = safeModeSnapshot();
    expect(Object.keys(snapshot).sort()).toEqual([...REAL_ACTION_FLAGS].sort());
  });
});

describe('isFullySafeMode()', () => {
  it('is true when no flag is set', () => {
    expect(isFullySafeMode()).toBe(true);
  });

  it.each(REAL_ACTION_FLAGS)('is false when %s alone is enabled', (flag) => {
    process.env[flag] = 'true';
    expect(isFullySafeMode()).toBe(false);
  });
});
