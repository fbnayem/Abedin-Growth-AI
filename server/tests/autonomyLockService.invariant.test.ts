import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * INVARIANTS FOR THE LOCK SERVICE AND FOR THE GUARDRAIL THAT GUARDS ERROR CODES.
 *
 * Everything in this file exists because a mutant survived, and each one said the same thing:
 * the behaviour was correct and nothing exercised it.
 *
 *   - The route reported the resulting lock state. Changing it to report `'PAUSED'` whatever
 *     the operator asked for passed the whole gate.
 *   - Dropping the attribution check from the route passed too.
 *   - Disabling the report branch of the error-code guardrail passed, because a guardrail run
 *     against a clean tree is silent whether or not it can still speak.
 *
 * A survivor is a statement about the tests. The first two are answered by moving the logic out
 * of the express handler into `autonomyLock.service.ts` and calling it here. The third is
 * answered by running the guardrail against a tree that actually contains the defect — the same
 * thing done by hand when it was written, done automatically so it stays true.
 */

/** The whole document store, in a map keyed on `path/id`. */
const documents: Record<string, Record<string, unknown>> = {};
let storeAvailable = true;
/**
 * Conversation ids whose read THROWS, for the batch path.
 *
 * A store that is entirely unavailable and a store that fails on one document are different
 * facts, and `readLocks` has to answer for the second without losing the rows it did read.
 */
const failingReads = new Set<string>();

vi.mock('../store', () => {
  const key = (ref: any) => `${ref.path}/${ref.id}`;
  const snapshot = (ref: any) => {
    if (failingReads.has(ref.id)) throw new Error(`read failed for ${ref.id}`);
    const present = Object.prototype.hasOwnProperty.call(documents, key(ref));
    return {
      id: ref.id,
      ref,
      exists: () => present,
      data: () => (present ? { ...documents[key(ref)] } : undefined),
    };
  };
  return {
    get store() {
      return storeAvailable ? { pool: {} } : null;
    },
    doc: (_first: any, path: string, id: string) => ({ kind: 'document', path, id }),
    getDoc: async (ref: any) => snapshot(ref),
    runTransaction: async (_handle: unknown, body: any) =>
      body({
        get: async (ref: any) => snapshot(ref),
        set: async (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => {
          const k = key(ref);
          documents[k] = options?.merge === true ? { ...(documents[k] ?? {}), ...data } : { ...data };
        },
      }),
  };
});

const { readLock, readLocks, readLocksFor, changeLock } = await import(
  '../services/autonomyLock.service'
);

const IDENTIFIED = { kind: 'IDENTIFIED' as const, actor: 'ops@example.com' };
const AT = '2026-09-08T12:00:00.000Z';
const CONV = 'organizations/acme/conversations/c1';

beforeEach(() => {
  for (const k of Object.keys(documents)) delete documents[k];
  storeAvailable = true;
  failingReads.clear();
});

describe('1. a change actually writes, and reports what it wrote', () => {
  it('pausing writes the flag the two guards read', async () => {
    const result = await changeLock({
      orgId: 'acme',
      conversationId: 'c1',
      body: { paused: true, reason: 'customer phoned in' },
      attribution: IDENTIFIED,
      at: AT,
    });
    expect(result.ok).toBe(true);
    expect(documents[CONV].autonomyPausedByHuman).toBe(true);
    expect(documents[CONV].autonomyLockReason).toBe('customer phoned in');
    expect(documents[CONV].autonomyLockActor).toBe('ops@example.com');
    expect(documents[CONV].autonomyLockAt).toBe(AT);
  });

  it('the reported state is the state requested — not a constant', () => {
    // The surviving mutant reported PAUSED whatever was asked. Both directions are asserted,
    // because a test of one direction cannot tell a derivation from a literal.
    return (async () => {
      const paused = await changeLock({
        orgId: 'acme', conversationId: 'c1',
        body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
      });
      expect(paused.ok && paused.to).toBe('PAUSED');

      const resumed = await changeLock({
        orgId: 'acme', conversationId: 'c1',
        body: { paused: false, reason: 'r' }, attribution: IDENTIFIED, at: AT,
      });
      expect(resumed.ok && resumed.to).toBe('RUNNING');
    })();
  });

  it('reports the state it came FROM, so an audit shows a real transition', async () => {
    const first = await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    // Nothing had been written, so the document did not exist: unreadable, not "running".
    expect(first.ok && first.from).toBe('UNKNOWN');

    const second = await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: false, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    expect(second.ok && second.from).toBe('PAUSED');
  });

  it('a pause MERGES, so draft-integrity fields survive it', async () => {
    // A pause that reset the inbound version would turn a safety action into a way of making a
    // stale draft look fresh.
    documents[CONV] = { inboundVersion: 7, approvalDigest: 'abc' };
    await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    expect(documents[CONV].inboundVersion).toBe(7);
    expect(documents[CONV].approvalDigest).toBe('abc');
    expect(documents[CONV].autonomyPausedByHuman).toBe(true);
  });

  it('an unattributed change records why, and names nobody', async () => {
    const result = await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' },
      attribution: { kind: 'UNATTRIBUTED', why: 'dev bootstrap' },
      at: AT,
    });
    expect(result.ok && result.actor).toBeNull();
    expect(result.ok && result.unattributedBecause).toBe('dev bootstrap');
    expect(documents[CONV].autonomyLockActor).toBeNull();
  });
});

describe('2. a malformed change writes nothing at all', () => {
  it('refuses and leaves the document untouched', async () => {
    for (const body of [{ paused: 'true', reason: 'r' }, { paused: true }, null, 'paused']) {
      const result = await changeLock({
        orgId: 'acme', conversationId: 'c1', body,
        attribution: IDENTIFIED, at: AT,
      });
      expect(result.ok, `accepted ${JSON.stringify(body)}`).toBe(false);
      expect(result.ok === false && result.code).toBe('VALIDATION_ERROR');
    }
    expect(documents[CONV]).toBeUndefined();
  });
});

describe('3. §14 — no datastore is not permission', () => {
  it('a change refuses rather than reporting success', async () => {
    storeAvailable = false;
    const result = await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('STORE_UNAVAILABLE');
  });

  it('a read refuses rather than answering RUNNING', async () => {
    // The original defect in one line: `if (!store) return false` meant no datastore was read
    // as "no human has taken this conversation", and the send proceeded.
    storeAvailable = false;
    const result = await readLock('acme', 'c1');
    expect(result.ok).toBe(false);
  });
});

describe('4. reading back what was written', () => {
  it('an untouched conversation reads UNKNOWN, because there is nothing to read', async () => {
    const result = await readLock('acme', 'c1');
    expect(result.ok && result.state).toBe('UNKNOWN');
  });

  it('a paused conversation reads PAUSED, with its reason and actor', async () => {
    await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'took over' }, attribution: IDENTIFIED, at: AT,
    });
    const result = await readLock('acme', 'c1');
    expect(result.ok && result.state).toBe('PAUSED');
    expect(result.ok && result.reason).toBe('took over');
    expect(result.ok && result.actor).toBe('ops@example.com');
  });

  it('a resumed conversation reads RUNNING', async () => {
    await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: false, reason: 'resolved' }, attribution: IDENTIFIED, at: AT,
    });
    const result = await readLock('acme', 'c1');
    expect(result.ok && result.state).toBe('RUNNING');
  });

  it('a non-string stored field reads as null rather than being coerced', async () => {
    documents[CONV] = { autonomyPausedByHuman: true, autonomyLockReason: 42 };
    const result = await readLock('acme', 'c1');
    expect(result.ok && result.reason).toBeNull();
  });
});

describe('5. tenancy — the path carries the organisation', () => {
  it('two tenants with the same conversation id do not collide', async () => {
    await changeLock({
      orgId: 'acme', conversationId: 'c1',
      body: { paused: true, reason: 'r' }, attribution: IDENTIFIED, at: AT,
    });
    const other = await readLock('globex', 'c1');
    expect(other.ok && other.state).toBe('UNKNOWN');
    expect(documents['organizations/globex/conversations/c1']).toBeUndefined();
  });
});

describe('6. the error-code guardrail can still fail', () => {
  /**
   * Disabling its report branch passed the gate, because a guardrail run against a clean tree
   * is silent whether or not it is still capable of speaking. So it is run against a tree that
   * contains the defect.
   */
  function fixture(code: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'envelope-'));
    mkdirSync(join(dir, 'server', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    // The real taxonomy, so the parser has something genuine to read.
    writeFileSync(
      join(dir, 'server', 'lib', 'errors.ts'),
      readFileSync('server/lib/errors.ts', 'utf8')
    );
    writeFileSync(
      join(dir, 'server', 'handler.ts'),
      `export const h = (req: any, res: any) => sendError(req, res, '${code}', 'no');\n`
    );
    writeFileSync(
      join(dir, 'scripts', 'check-error-envelope.mjs'),
      readFileSync('scripts/check-error-envelope.mjs', 'utf8')
    );
    return dir;
  }

  const runIn = (dir: string): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, ['scripts/check-error-envelope.mjs'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return { code: 0, out };
    } catch (e: any) {
      return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
    }
  };

  it('fails on a code that is not in the taxonomy', () => {
    const result = runIn(fixture('FORBIDDEN'));
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('FORBIDDEN');
    expect(result.out).toContain('not in ErrorCodes');
  });

  it('passes on a code that is', () => {
    // The other half. Without it, a check that failed on everything would satisfy the test
    // above while telling nobody anything.
    const result = runIn(fixture('NOT_FOUND'));
    expect(result.code, result.out).toBe(0);
  });
});

describe('the batch read the operator console draws its badges from', () => {
  const paused = { autonomyPausedByHuman: true, autonomyLockReason: 'customer called in' };

  it('reports each conversation it could read', async () => {
    documents['organizations/acme/conversations/c1'] = paused;
    documents['organizations/acme/conversations/c2'] = { autonomyPausedByHuman: false };

    const result = await readLocks('acme', ['c1', 'c2']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locks.c1.state).toBe('PAUSED');
      expect(result.locks.c1.reason).toBe('customer called in');
      expect(result.locks.c2.state).toBe('RUNNING');
    }
  });

  /**
   * THE INVERSION THIS EXISTS TO PREVENT.
   *
   * A conversation whose read threw must be ABSENT from the map. `lockStateAt` in
   * `shared/domain/autonomyDisplay.ts` reads an absent conversation as UNKNOWN, which the
   * console renders as a refusal. An entry saying RUNNING because the read failed would put a
   * green "autonomy active" badge on the screen at the exact moment the datastore is in
   * trouble, which is §14 inverted on the one surface an operator uses during an incident.
   */
  it('a conversation whose read threw is OMITTED, never defaulted', async () => {
    documents['organizations/acme/conversations/c1'] = paused;
    failingReads.add('c2');

    const result = await readLocks('acme', ['c1', 'c2']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.prototype.hasOwnProperty.call(result.locks, 'c2')).toBe(false);
      // And the readable rows survive: one bad document must not cost the operator the
      // paused conversations they can still see.
      expect(result.locks.c1.state).toBe('PAUSED');
    }
  });

  it('a conversation that does not exist is UNKNOWN rather than absent', async () => {
    // Different from the case above and deliberately so. "The document is not there" is an
    // answer the store gave; "the read threw" is not an answer at all. Both refuse, but only
    // the first is something the console can state.
    const result = await readLocks('acme', ['never-seen']);
    expect(result.ok && result.locks['never-seen'].state).toBe('UNKNOWN');
  });

  it('an empty list is an empty map, not everything', async () => {
    documents['organizations/acme/conversations/c1'] = paused;
    const result = await readLocks('acme', []);
    expect(result.ok && Object.keys(result.locks)).toEqual([]);
  });

  it('no datastore refuses the whole batch rather than reporting running', async () => {
    storeAvailable = false;
    const result = await readLocks('acme', ['c1'], null);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('STORE_UNAVAILABLE');
  });

  /**
   * `readLocksFor` — the parse and the read together, because the ROUTE cannot be tested.
   *
   * The route used to parse the id list and branch on the result itself. Replacing that branch
   * with `if (false)` — so `a/b`, `a,,b` and an unbounded list all reached the store — survived
   * the entire gate. Nothing exercised it, because exercising an express handler needs a
   * request. This is the third decision on this control that had to move out of a handler
   * before a test could reach it.
   */
  it('refuses a malformed id list rather than reading it', async () => {
    for (const bad of ['a,,b', 'a/b', '..', Array(200).fill('c').map((c, i) => c + i).join(',')]) {
      const result = await readLocksFor('acme', bad);
      expect(result.ok, `accepted ${bad}`).toBe(false);
      expect(result.ok === false && result.code).toBe('VALIDATION_ERROR');
    }
  });

  it('reads the conversations named in a well-formed list', async () => {
    documents['organizations/acme/conversations/c1'] = { autonomyPausedByHuman: true };
    const result = await readLocksFor('acme', 'c1,c2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.locks.c1.state).toBe('PAUSED');
      expect(result.locks.c2.state).toBe('UNKNOWN');
    }
  });

  it('an absent parameter reads nothing rather than everything', async () => {
    documents['organizations/acme/conversations/c1'] = { autonomyPausedByHuman: true };
    const result = await readLocksFor('acme', undefined);
    expect(result.ok && Object.keys(result.locks)).toEqual([]);
  });

  it('the batch is tenant-scoped', async () => {
    documents['organizations/acme/conversations/c1'] = paused;
    const other = await readLocks('other-tenant', ['c1']);
    // Another tenant asking about the same id reads its own (absent) conversation.
    expect(other.ok && other.locks.c1.state).toBe('UNKNOWN');
  });
});
