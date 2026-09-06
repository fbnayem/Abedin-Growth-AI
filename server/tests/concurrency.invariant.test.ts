import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * INVARIANTS (addendum §7, §6, §14 / P1.3).
 *
 * §7  A concurrent write is detected and refused, not silently applied. Two writers editing
 *     the same record produce one success and one 409 — never two successes and one lost edit.
 * §14 A write that does not state which revision it is updating is REFUSED, not assumed to
 *     mean "whatever is there now". That assumption is exactly what produced the lost updates
 *     this replaces.
 *
 * Every mutable document in this system was previously written blind: `setDoc(ref, req.body)`
 * for the settings and company brain, a read-modify-write toggle for campaigns, and a bare
 * `updateDoc` for pipeline stages. None of them left evidence that a write had been lost.
 */

interface StoredDoc {
  [key: string]: unknown;
}

let store: Record<string, StoredDoc> = {};
let transactionShouldThrow = false;
/** Fires once, between the transaction's read and its write, to simulate a real interleave. */
let interleave: (() => void) | null = null;

vi.mock('../firebase', () => ({
  firestore: {},
  firebaseAuth: null,
}));

/**
 * A Firestore transaction double that actually behaves like one.
 *
 * The important part is the ABORT: Firestore records what a transaction read and refuses the
 * commit if any of it changed in the meantime. A mock that simply applies the writes would let
 * an interleaving-writer test pass while proving nothing, so reads are tracked and the commit
 * is checked against them — the same guarantee the real store gives.
 */
vi.mock('firebase/firestore', () => ({
  runTransaction: async (_db: unknown, fn: any) => {
    if (transactionShouldThrow) throw new Error('aborted: too much contention');

    const readAt: Record<string, string> = {};
    const pending: Record<string, StoredDoc> = {};

    const snapshotOf = (path: string) => JSON.stringify(store[path] ?? null);

    const result = await fn({
      get: async (ref: any) => {
        const exists = Object.prototype.hasOwnProperty.call(store, ref.path);
        const data = exists ? { ...store[ref.path] } : undefined;
        readAt[ref.path] = snapshotOf(ref.path);

        // The interleaving writer commits here: after this transaction has read, before it
        // writes. This is the window the version check alone cannot close.
        if (interleave) {
          const fire = interleave;
          interleave = null;
          fire();
        }
        return { exists: () => exists, data: () => data };
      },
      set: (ref: any, value: any) => {
        pending[ref.path] = value;
      },
    });

    // Commit: refuse if anything read has changed since it was read.
    for (const [path, seen] of Object.entries(readAt)) {
      if (snapshotOf(path) !== seen) {
        throw new Error('aborted: a document read by this transaction changed before commit');
      }
    }
    Object.assign(store, pending);
    return result;
  },
}));

const {
  versionOf,
  expectedVersionFrom,
  mutateWithVersion,
  sendMutationOutcome,
  sendVersionRequired,
} = await import('../lib/concurrency');

const ref = (path: string) => ({ path }) as any;

/** Minimal Express request double. requestId is what the error envelope reports back. */
function makeReq(over: Record<string, unknown> = {}) {
  return { headers: {}, body: {}, method: 'POST', originalUrl: '/api/thing', requestId: 'req-test', ...over } as any;
}

/** Minimal Express response double: status code, body and headers are what a caller sees. */
function makeRes() {
  const captured: { status: number; body: any; headers: Record<string, string> } = {
    status: 200,
    body: null,
    headers: {},
  };
  const res: any = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: any) {
      captured.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
  };
  return { res, captured };
}

beforeEach(() => {
  store = {};
  transactionShouldThrow = false;
  interleave = null;
});

// ---------------------------------------------------------------------------
describe('§7 — reading a version', () => {
  it('an absent document is version 0, so a create is expressible', () => {
    expect(versionOf(null, false)).toBe(0);
  });

  it('a document with no version field is 0, not "trusted"', () => {
    // Such a document predates the mechanism. Treating it as "whatever the caller says" would
    // exempt every pre-existing record from the check.
    expect(versionOf({ name: 'x' }, true)).toBe(0);
  });

  it('reads an integer version', () => {
    expect(versionOf({ version: 7 }, true)).toBe(7);
  });

  it('THROWS on a malformed version rather than coercing it', () => {
    // Coercion would make the comparison meaningless in exactly the case where something has
    // already gone wrong with the document.
    for (const bad of [{ version: -1 }, { version: 1.5 }, { version: 'x' }, { version: {} }]) {
      expect(() => versionOf(bad, true)).toThrow(/malformed/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('§14 — a write without an expected version is refused', () => {
  const req = (over: any = {}) => ({ headers: {}, body: {}, ...over }) as any;

  it('REFUSES when neither If-Match nor expectedVersion is present', () => {
    const outcome = expectedVersionFrom(req());
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.code).toBe('VERSION_REQUIRED');
  });

  it('REFUSES If-Match: * — the wildcard means "overwrite whatever is there"', () => {
    const outcome = expectedVersionFrom(req({ headers: { 'if-match': '*' } }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.code).toBe('VERSION_MALFORMED');
  });

  it('accepts a bare, quoted, or weak ETag — all three are forms a client may echo back', () => {
    for (const header of ['3', '"3"', 'W/"3"']) {
      const outcome = expectedVersionFrom(req({ headers: { 'if-match': header } }));
      expect(outcome.ok, header).toBe(true);
      if (outcome.ok) expect(outcome.value).toBe(3);
    }
  });

  it('accepts expectedVersion in the body', () => {
    const outcome = expectedVersionFrom(req({ body: { expectedVersion: 2 } }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toBe(2);
  });

  it('REFUSES a malformed version rather than defaulting it to 0', () => {
    for (const bad of ['-1', '1.5', 'latest', 'null']) {
      const outcome = expectedVersionFrom(req({ headers: { 'if-match': bad } }));
      expect(outcome.ok, bad).toBe(false);
    }
  });

  it('answers 428 with the current version, so recovery is one retry', () => {
    const { res, captured } = makeRes();
    sendVersionRequired(makeReq(), res, { ok: false, code: 'VERSION_REQUIRED', message: 'x' }, 4);
    expect(captured.status).toBe(428);
    expect(captured.body.error.details.currentVersion).toBe(4);
    expect(captured.headers.ETag).toBe('"4"');
  });
});

// ---------------------------------------------------------------------------
describe('§7 — the mutation itself', () => {
  it('creates at expectedVersion 0 and stores version 1', async () => {
    const outcome = await mutateWithVersion(ref('d/1'), 0, () => ({ name: 'first' }));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.version).toBe(1);
    expect(store['d/1']).toMatchObject({ name: 'first', version: 1 });
  });

  it('REFUSES a second create at version 0 — two creates race like any other write', async () => {
    await mutateWithVersion(ref('d/1'), 0, () => ({ name: 'first' }));
    const second = await mutateWithVersion(ref('d/1'), 0, () => ({ name: 'second' }));

    expect(second.ok).toBe(false);
    if (second.ok === false && second.code === 'VERSION_CONFLICT') {
      expect(second.currentVersion).toBe(1);
    } else {
      throw new Error('expected a VERSION_CONFLICT');
    }
    expect(store['d/1']).toMatchObject({ name: 'first' });
  });

  it('increments monotonically across successive writes', async () => {
    await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));
    await mutateWithVersion(ref('d/1'), 1, () => ({ n: 2 }));
    const third = await mutateWithVersion(ref('d/1'), 2, () => ({ n: 3 }));
    expect(third.ok && third.version).toBe(3);
  });

  it('THE CORE CASE: a write against a stale version is refused, and the first edit survives', async () => {
    // Two operators load version 1. A saves. B saves against version 1 and must NOT win.
    await mutateWithVersion(ref('d/brain'), 0, () => ({ pricing: 'original' }));

    const operatorA = await mutateWithVersion(ref('d/brain'), 1, () => ({ pricing: 'A edit' }));
    expect(operatorA.ok).toBe(true);

    const operatorB = await mutateWithVersion(ref('d/brain'), 1, () => ({ pricing: 'B edit' }));
    expect(operatorB.ok).toBe(false);
    if (operatorB.ok === false && operatorB.code === 'VERSION_CONFLICT') {
      expect(operatorB.currentVersion).toBe(2);
    } else {
      throw new Error('expected a VERSION_CONFLICT');
    }

    // A's edit is intact. Before P1.3, B's blind setDoc would have destroyed it silently.
    expect(store['d/brain']).toMatchObject({ pricing: 'A edit', version: 2 });
  });

  it('REFUSES a writer that commits BETWEEN this transaction reading and writing', async () => {
    // The window the version comparison alone cannot close: this transaction reads version 1,
    // finds it matches its expectation, and only then does someone else commit. Closing it is
    // the store's job, which is precisely why the comparison lives INSIDE the transaction
    // rather than as a read followed by a separate write.
    await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));

    interleave = () => {
      store['d/1'] = { n: 99, version: 2 };
    };

    const outcome = await mutateWithVersion(ref('d/1'), 1, () => ({ n: 2 }));

    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.code).toBe('VERSION_CONFLICT');
    // The interleaving writer's value survives; this caller's write did not land.
    expect(store['d/1']).toMatchObject({ n: 99, version: 2 });
  });

  it('reports a transaction abort as a CONFLICT, not a server fault', async () => {
    // An abort means someone else committed first. Calling it a 500 sends an operator to look
    // at the server when the correct action is to re-read and retry.
    transactionShouldThrow = true;
    const outcome = await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.code).toBe('VERSION_CONFLICT');
  });

  it('REFUSES to let a payload set its own version', async () => {
    // Otherwise a client could pin the version and make every subsequent write conflict, or
    // rewind it and defeat the check entirely.
    await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1, version: 999 } as any));
    expect(store['d/1'].version).toBe(1);
  });

  it('stamps updatedAt as an ISO string, matching the domain type', async () => {
    // The domain declares `updatedAt: string`. An epoch number here type-checks (everything
    // through Firestore is `any`) and then renders as a bare millisecond count in the UI.
    await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));
    const updatedAt = store['d/1'].updatedAt;
    expect(typeof updatedAt).toBe('string');
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(updatedAt as string).toISOString()).toBe(updatedAt);
  });

  it('writes the document whole, so a removed field is genuinely removed', async () => {
    await mutateWithVersion(ref('d/1'), 0, () => ({ keep: 'a', drop: 'b' }));
    await mutateWithVersion(ref('d/1'), 1, () => ({ keep: 'a' }));
    expect(store['d/1']).not.toHaveProperty('drop');
  });

  it('answers NOT_FOUND when the caller required an existing document', async () => {
    const outcome = await mutateWithVersion(ref('d/missing'), 0, () => ({ n: 1 }), {
      requireExisting: true,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('§12 — the outcome maps to one HTTP shape', () => {
  it('success carries the new version in the body and the ETag', async () => {
    const outcome = await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));
    const { res, captured } = makeRes();
    sendMutationOutcome(makeReq(), res, outcome);
    expect(captured.status).toBe(200);
    expect(captured.body.version).toBe(1);
    expect(captured.headers.ETag).toBe('"1"');
  });

  it('a conflict is 409 and carries the CURRENT version, so the client can recover', async () => {
    await mutateWithVersion(ref('d/1'), 0, () => ({ n: 1 }));
    const stale = await mutateWithVersion(ref('d/1'), 0, () => ({ n: 2 }));

    const { res, captured } = makeRes();
    sendMutationOutcome(makeReq(), res, stale);
    expect(captured.status).toBe(409);
    expect(captured.body.error.code).toBe('VERSION_CONFLICT');
    expect(captured.body.error.details.currentVersion).toBe(1);
  });

  it('a missing document is 404 and an unavailable store is 503', async () => {
    const notFound = await mutateWithVersion(ref('d/x'), 0, () => ({}), { requireExisting: true });
    const a = makeRes();
    sendMutationOutcome(makeReq(), a.res, notFound);
    expect(a.captured.status).toBe(404);

    const b = makeRes();
    sendMutationOutcome(makeReq(), b.res, {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      message: 'x',
    });
    expect(b.captured.status).toBe(503);
  });
});
