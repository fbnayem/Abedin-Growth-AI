import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  lockStateOf,
  mayProceed,
  refusalFor,
  lockChangeFrom,
  lockRecord,
  LOCK_FIELD,
  LOCK_STATUS,
  MAX_REASON_LENGTH,
  type LockState,
} from '../domain/autonomyLock';

/**
 * INVARIANTS FOR THE PER-CONVERSATION AUTONOMY LOCK (addendum §14, §38).
 *
 * The defect this replaces is not a wrong answer, it is a control with no way to engage it.
 * `actionGateway.checkHumanOwnershipLock` and `outbox.worker` both refused to dispatch when
 * `autonomyPausedByHuman` was set, and the only writer of that field lived in a service with
 * no callers anywhere in the repository. A human watching the system draft the wrong thing to
 * a customer could not stop it for that customer.
 *
 * So the first thing asserted here is that a writer EXISTS and is reachable. The rest is what
 * the readers do when the answer is not a clean boolean, which is where all three of the old
 * inversions lived.
 */

const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
const worker = readFileSync('server/workers/outbox.worker.ts', 'utf8');
const route = readFileSync('server/routes/autonomy.routes.ts', 'utf8');
const service = readFileSync('server/services/autonomyLock.service.ts', 'utf8');
const serverEntry = readFileSync('server.ts', 'utf8');

describe('1. the lock has a writer, and it is reachable', () => {
  it('something writes the field the guards read', () => {
    // The whole defect in one assertion. Before this, the only writer was
    // aiSafetyService.setHumanOwnershipLock, which nothing called.
    expect(service).toContain('lockRecord(');
    expect(service).toMatch(/tx\.set\(/);
  });

  it('the writer is reachable from the route — the chain, not just its ends', () => {
    // Asserting that a writer exists and that a router is mounted proves neither is connected
    // to the other. A service nothing calls is the same defect in a new file.
    expect(route).toContain("from '../services/autonomyLock.service'");
    expect(route).toContain('changeLock(');
  });

  it('the router is mounted, so the writer is not another unreachable module', () => {
    // A route file that exists and is never mounted is exactly the shape of the thing being
    // fixed. Asserting the import alone would not catch it; the mount is what makes it real.
    expect(serverEntry).toContain('autonomyRouter');
    expect(serverEntry).toMatch(/app\.use\(\s*["']\/api\/autonomy["']\s*,\s*autonomyRouter\s*\)/);
  });

  it('the write is attributed, and the body is validated', () => {
    expect(route).toContain('operatorGate(');
    expect(service).toContain('lockChangeFrom(');
  });

  it('the dead shadow service is gone', () => {
    // It held a duplicate WorkflowBudget (the live one is server/policies/workflowBudgets.ts),
    // a staleness check that answered "not stale" when it could not tell, and the only writer
    // this lock had. Keeping it would leave a second implementation for a maintainer to fix
    // instead of the live one.
    let exists = true;
    try {
      readFileSync('server/services/aiSafety.service.ts', 'utf8');
    } catch {
      exists = false;
    }
    expect(exists, 'server/services/aiSafety.service.ts is back').toBe(false);
  });
});

describe('2. both guards read the SAME function, so they cannot disagree again', () => {
  /**
   * They already had. The worker honoured `status === 'AUTONOMY_PAUSED_BY_HUMAN'` as a pause
   * and the gateway did not, so a conversation paused by status was stopped by one and
   * permitted by the other — for the same conversation, in the same send.
   */
  it('the gateway decides through lockStateOf and mayProceed', () => {
    expect(gateway).toContain('lockStateOf(');
    expect(gateway).toContain('mayProceed(');
  });

  it('the worker decides through the same pair', () => {
    expect(worker).toContain('lockStateOf(');
    expect(worker).toContain('mayProceed(');
  });

  it('neither reads the raw field truthily any more', () => {
    // `if (data?.autonomyPausedByHuman)` is the pattern that let coercion decide.
    const stripped = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(stripped(gateway)).not.toMatch(/\?\.\s*autonomyPausedByHuman/);
    expect(stripped(worker)).not.toMatch(/\?\.\s*autonomyPausedByHuman/);
  });
});

describe('3. §14 — an unknown lock state is not permission', () => {
  it('a document that does not exist is UNKNOWN, not RUNNING', () => {
    // This was `return false` — "not locked" — in both readers. We had read nothing at all.
    expect(lockStateOf(false, undefined)).toBe('UNKNOWN');
    expect(lockStateOf(false, { [LOCK_FIELD]: false })).toBe('UNKNOWN');
  });

  it('data that is not an object is UNKNOWN', () => {
    expect(lockStateOf(true, null)).toBe('UNKNOWN');
    expect(lockStateOf(true, 'paused')).toBe('UNKNOWN');
    expect(lockStateOf(true, 42)).toBe('UNKNOWN');
  });

  it('a value that is not a boolean is UNKNOWN, however it would coerce', () => {
    // The old readers used truthiness: `"false"` is truthy and would have PAUSED, `0` is
    // falsy and would have RUN. Both are values nobody here wrote.
    for (const bad of ['true', 'false', 0, 1, {}, [], 'yes']) {
      expect(lockStateOf(true, { [LOCK_FIELD]: bad }), `accepted ${JSON.stringify(bad)}`).toBe(
        'UNKNOWN'
      );
    }
  });

  it('UNKNOWN refuses', () => {
    expect(mayProceed('UNKNOWN')).toBe(false);
  });

  it('an unrecognised state refuses too', () => {
    // `mayProceed` is `=== RUNNING`, not `!== PAUSED`. A fourth state added without thought
    // must fail closed — the dispatch gate's `default: return true` is how the opposite went
    // wrong in this codebase already.
    expect(mayProceed('SOMETHING_NEW' as LockState)).toBe(false);
  });
});

describe('4. the states a conversation can actually be in', () => {
  it('the flag set to true is PAUSED', () => {
    expect(lockStateOf(true, { [LOCK_FIELD]: true })).toBe('PAUSED');
  });

  it('the legacy status alone is PAUSED — the worker already honoured it', () => {
    expect(lockStateOf(true, { status: LOCK_STATUS })).toBe('PAUSED');
  });

  it('a document with no lock field at all is RUNNING', () => {
    // The one place a missing value reads as permission, and it needs its reason: the field is
    // written only by a pause or a resume, so its absence is the positive fact that nobody has
    // acted. Reading it as UNKNOWN would refuse every send in the system forever.
    expect(lockStateOf(true, { inboundVersion: 3 })).toBe('RUNNING');
    expect(lockStateOf(true, {})).toBe('RUNNING');
  });

  it('an explicit false RESUMES, even over the legacy status', () => {
    // Ordering, and it is the difference between a resume that works and one that silently
    // does nothing. If the status were checked first, a conversation paused by status could
    // never be resumed: the operator sets the flag false, the read keeps seeing the status,
    // and the API reports success while the send stays blocked forever.
    expect(lockStateOf(true, { [LOCK_FIELD]: false, status: LOCK_STATUS })).toBe('RUNNING');
  });

  it('true wins over an explicit false — a pause is never overridden by a stale field', () => {
    expect(lockStateOf(true, { [LOCK_FIELD]: true, status: 'ACTIVE' })).toBe('PAUSED');
  });

  it('only RUNNING proceeds', () => {
    expect(mayProceed('RUNNING')).toBe(true);
    expect(mayProceed('PAUSED')).toBe(false);
  });
});

describe('5. a refusal can be explained, and a non-refusal cannot', () => {
  it('names the conversation, so an operator can find it', () => {
    expect(refusalFor('PAUSED', 'conv_42')).toContain('conv_42');
    expect(refusalFor('UNKNOWN', 'conv_42')).toContain('conv_42');
  });

  it('says which of the two it is', () => {
    expect(refusalFor('PAUSED', 'c')).toMatch(/human has taken ownership/i);
    expect(refusalFor('UNKNOWN', 'c')).toMatch(/cannot determine/i);
  });

  it('throws when asked to explain a send it is permitting', () => {
    // Same shape as campaignSafety.refusalReason. A function that invents a reason for a
    // permitted action produces log lines describing refusals that never happened.
    expect(() => refusalFor('RUNNING', 'c')).toThrow(/permits the send/);
  });
});

describe('6. §14 — a change request must say what it means', () => {
  it('accepts a well-formed pause and resume', () => {
    expect(lockChangeFrom({ paused: true, reason: 'customer phoned in' })).toEqual({
      ok: true,
      value: { paused: true, reason: 'customer phoned in' },
    });
    expect(lockChangeFrom({ paused: false, reason: 'issue resolved' }).ok).toBe(true);
  });

  it('refuses a non-boolean `paused`, however it would coerce', () => {
    // The important one is the string. `"false"` is truthy, so a coercing parser would RESUME
    // a conversation for a caller who sent the word "false".
    for (const bad of ['true', 'false', 1, 0, null, undefined, {}]) {
      expect(lockChangeFrom({ paused: bad, reason: 'r' }).ok, `accepted ${String(bad)}`).toBe(
        false
      );
    }
  });

  it('requires a reason in both directions', () => {
    expect(lockChangeFrom({ paused: true }).ok).toBe(false);
    expect(lockChangeFrom({ paused: false }).ok).toBe(false);
    expect(lockChangeFrom({ paused: true, reason: '' }).ok).toBe(false);
    expect(lockChangeFrom({ paused: true, reason: '   ' }).ok).toBe(false);
    expect(lockChangeFrom({ paused: true, reason: 7 }).ok).toBe(false);
  });

  it('caps the reason, because it is stored and rendered', () => {
    expect(lockChangeFrom({ paused: true, reason: 'x'.repeat(MAX_REASON_LENGTH) }).ok).toBe(true);
    expect(lockChangeFrom({ paused: true, reason: 'x'.repeat(MAX_REASON_LENGTH + 1) }).ok).toBe(
      false
    );
  });

  it('refuses a body that is not an object', () => {
    for (const bad of [null, undefined, 'paused', 42, [true]]) {
      expect(lockChangeFrom(bad).ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('trims the reason rather than storing the whitespace somebody typed', () => {
    const parsed = lockChangeFrom({ paused: true, reason: '  took over  ' });
    expect(parsed.ok && parsed.value.reason).toBe('took over');
  });
});

describe('7. §38 — the record says who, or says that nobody could be identified', () => {
  const at = '2026-09-08T12:00:00.000Z';
  const change = { paused: true, reason: 'took over' };

  it('an identified operator is named', () => {
    const record = lockRecord({
      change,
      attribution: { kind: 'IDENTIFIED', actor: 'ops@example.com' },
      at,
    });
    expect(record.autonomyLockActor).toBe('ops@example.com');
    expect(record.autonomyLockUnattributedReason).toBeNull();
  });

  it('an unattributed action records WHY, and names nobody', () => {
    // `actor: 'unknown-operator'` reads in an audit log exactly like a user account of that
    // name. "Nobody could be identified" is a different fact and is stored as one.
    const record = lockRecord({
      change,
      attribution: { kind: 'UNATTRIBUTED', why: 'no identity on the request' },
      at,
    });
    expect(record.autonomyLockActor).toBeNull();
    expect(record.autonomyLockUnattributedReason).toBe('no identity on the request');
  });

  it('the two fields are never both populated', () => {
    for (const attribution of [
      { kind: 'IDENTIFIED' as const, actor: 'a@b.c' },
      { kind: 'UNATTRIBUTED' as const, why: 'dev' },
    ]) {
      const record = lockRecord({ change, attribution, at });
      const both =
        record.autonomyLockActor !== null && record.autonomyLockUnattributedReason !== null;
      expect(both).toBe(false);
    }
  });

  it('the timestamp is passed in, not read from the clock', () => {
    // §30. A record that reads the clock cannot be held still by a test, and this one is an
    // audit row: the time it claims has to be the time the caller recorded.
    expect(
      lockRecord({ change, attribution: { kind: 'IDENTIFIED', actor: 'a' }, at }).autonomyLockAt
    ).toBe(at);
    const source = readFileSync('server/domain/autonomyLock.ts', 'utf8');
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    expect(stripped).not.toMatch(/Date\.now\(\)|new Date\(\)/);
  });
});

describe('8. the round trip the route depends on', () => {
  /**
   * The route reports the resulting state as `paused ? 'PAUSED' : 'RUNNING'` rather than
   * re-reading the document, because `server/store/index.ts` records that nothing in this
   * repository reads a document after writing it in the same transaction. That shortcut is
   * only honest if writing a record and reading it back really does give the state requested —
   * so it is asserted rather than assumed.
   */
  it('writing a pause reads back as PAUSED', () => {
    const record = lockRecord({
      change: { paused: true, reason: 'r' },
      attribution: { kind: 'IDENTIFIED', actor: 'a' },
      at: '2026-09-08T00:00:00.000Z',
    });
    expect(lockStateOf(true, record)).toBe('PAUSED');
  });

  it('writing a resume reads back as RUNNING', () => {
    const record = lockRecord({
      change: { paused: false, reason: 'r' },
      attribution: { kind: 'IDENTIFIED', actor: 'a' },
      at: '2026-09-08T00:00:00.000Z',
    });
    expect(lockStateOf(true, record)).toBe('RUNNING');
  });

  it('a resume reads back as RUNNING even merged over a legacy status pause', () => {
    // The merge case in production: the stored document already carries the legacy status and
    // the resume writes only the lock fields over it.
    const record = lockRecord({
      change: { paused: false, reason: 'r' },
      attribution: { kind: 'IDENTIFIED', actor: 'a' },
      at: '2026-09-08T00:00:00.000Z',
    });
    expect(lockStateOf(true, { status: LOCK_STATUS, ...record })).toBe('RUNNING');
  });
});
