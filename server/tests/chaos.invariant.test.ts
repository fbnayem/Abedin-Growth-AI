import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * S42 — FAULT INJECTION ACROSS THE AUTONOMOUS SEND PATH.
 *
 * Every invariant here is about what happens when something goes wrong at the worst moment. The
 * section lists fifteen failure modes; the machinery to survive them landed piecemeal across
 * P0.5, P0.8, P0.9, P0.10 and P0.11, and none of it had ever been exercised under an actual
 * fault. Code that survives a fault is not the same claim as code written to survive one, and
 * only the first is checkable.
 *
 * WHY THIS RUNS THE REAL SERVICE
 * ------------------------------
 * The datastore is a double, and the double aborts a transaction whose reads changed before
 * commit — the guarantee Firestore actually gives, and the one every claim in this file depends
 * on. A mock that simply applied the writes would let the concurrency tests pass while proving
 * nothing: two workers would both "win" and the assertion would still read one row.
 *
 * Everything above the datastore is the real thing: `claimPendingJobs`, `markFailed`,
 * `reapExpiredLeases` and `markProcessed` are imported and called, not reimplemented. A test
 * that reimplements the logic it is checking tests the reimplementation.
 *
 * WHAT IS AND IS NOT COVERED
 * --------------------------
 * These are queue-level faults: concurrent claims, crashes between the provider call and the
 * status write, retryable versus terminal failure, lease expiry, backoff. The provider-level
 * modes S42 also lists — a 429 from Gmail, an expired refresh token, a webhook delivered twice
 * — need the gateway and a provider double and are NOT here; that gap is stated in the status
 * document rather than implied by this file's existence.
 */

interface StoredDoc {
  [key: string]: unknown;
}

let store: Record<string, StoredDoc> = {};
/** Fires once, between a transaction's read and its commit, to produce a real interleave. */
let interleave: (() => void) | null = null;
/**
 * Fires once BEFORE a transaction's first read, so the transaction sees the changed value and
 * commits without conflict.
 *
 * This is the window the abort cannot close, and it is the one the in-transaction re-read exists
 * for: the candidate list is fetched outside the transaction, so a row can be taken between the
 * query and the claim. Without this hook, mutating the status re-read away left every
 * concurrency test passing, because the abort caught the interleave instead — the guard was
 * covered by a different guard rather than by a test.
 */
let beforeRead: (() => void) | null = null;
/** How many transactions were opened. A guard that avoids opening one is otherwise invisible. */
let transactionCount = 0;
let now = 1_700_000_000_000;

vi.mock('../firebase', () => ({
  firestore: {},
  firebaseAuth: null,
}));

const pathOf = (ref: any): string => ref.path;

/**
 * A Firestore double whose transaction ABORTS when something it read has changed.
 *
 * That abort is the whole mechanism under test. `claimPendingJobs` re-reads the row inside the
 * transaction and refuses if it is no longer PENDING; the abort is the second line of defence
 * for the case where the status was still PENDING at read time and another worker committed
 * first.
 */
vi.mock('firebase/firestore', () => {
  const collectionKey = (c: any) => c.path as string;

  return {
    collection: (_db: unknown, path: string) => ({ path }),
    /**
     * The modular SDK's `doc` has three shapes and the service uses two of them:
     * `doc(db, 'a/b/c', id)` and `doc(collectionRef, id)`. An earlier version of this double
     * handled only the two-argument form, so every path came out as a generated string, nothing
     * matched, and every test failed identically — which reads like the code being broken
     * rather than the harness.
     */
    doc: (first: any, ...rest: any[]) => {
      if (typeof first === 'string') return { path: [first, ...rest].join('/') };
      if (first && typeof first.path === 'string') {
        return { path: [first.path, ...rest].join('/') };
      }
      // `first` is the database handle; the path is whatever follows it.
      return { path: rest.join('/') };
    },
    getDoc: async (ref: any) => {
      const exists = Object.prototype.hasOwnProperty.call(store, pathOf(ref));
      return { exists: () => exists, data: () => (exists ? { ...store[pathOf(ref)] } : undefined) };
    },
    getDocs: async (q: any) => {
      const prefix = q.collectionPath + '/';
      const docs = Object.entries(store)
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => q.filters.every((f: any) => (data as any)[f.field] === f.value))
        .slice(0, q.limit ?? Infinity)
        .map(([path, data]) => ({
          id: path.slice(prefix.length),
          ref: { path },
          data: () => ({ ...data }),
        }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn: any) => docs.forEach(fn) };
    },
    query: (c: any, ...clauses: any[]) => ({
      collectionPath: collectionKey(c),
      filters: clauses.filter((x) => x.kind === 'where'),
      limit: clauses.find((x) => x.kind === 'limit')?.value,
    }),
    where: (field: string, _op: string, value: unknown) => ({ kind: 'where', field, value }),
    limit: (value: number) => ({ kind: 'limit', value }),
    orderBy: () => ({ kind: 'orderBy' }),
    setDoc: async (ref: any, value: any) => {
      store[pathOf(ref)] = { ...value };
    },
    updateDoc: async (ref: any, value: any) => {
      store[pathOf(ref)] = { ...(store[pathOf(ref)] ?? {}), ...value };
    },
    runTransaction: async (_db: unknown, fn: any) => {
      transactionCount++;
      const readAt: Record<string, string> = {};
      const pendingSet: Record<string, StoredDoc> = {};
      const pendingUpdate: Record<string, StoredDoc> = {};
      const snapshotOf = (path: string) => JSON.stringify(store[path] ?? null);

      const result = await fn({
        get: async (ref: any) => {
          // Before the snapshot is taken, so the transaction sees the new value and commits
          // cleanly. Only the in-transaction re-read can refuse it.
          if (beforeRead) {
            const fire = beforeRead;
            beforeRead = null;
            fire();
          }
          const path = pathOf(ref);
          const exists = Object.prototype.hasOwnProperty.call(store, path);
          readAt[path] = snapshotOf(path);
          // The competing writer commits here: after this transaction read, before it writes.
          if (interleave) {
            const fire = interleave;
            interleave = null;
            fire();
          }
          return { exists: () => exists, data: () => (exists ? { ...store[path] } : undefined) };
        },
        set: (ref: any, value: any) => {
          pendingSet[pathOf(ref)] = { ...value };
        },
        update: (ref: any, value: any) => {
          pendingUpdate[pathOf(ref)] = { ...(pendingUpdate[pathOf(ref)] ?? {}), ...value };
        },
      });

      for (const [path, seen] of Object.entries(readAt)) {
        if (snapshotOf(path) !== seen) {
          throw new Error('aborted: a document read by this transaction changed before commit');
        }
      }
      for (const [path, value] of Object.entries(pendingSet)) store[path] = value;
      for (const [path, value] of Object.entries(pendingUpdate)) {
        store[path] = { ...(store[path] ?? {}), ...value };
      }
      return result;
    },
  };
});

vi.mock('uuid', () => ({ v4: () => `uuid-${Object.keys(store).length}` }));

const { outboxService, MAX_ATTEMPTS, LEASE_MS } = await import('../services/outbox.service');

const ORG = 'org-chaos';
const QUEUE = `organizations/${ORG}/outbox`;

function seedJob(id: string, over: Record<string, unknown> = {}) {
  store[`${QUEUE}/${id}`] = {
    id,
    organizationId: ORG,
    conversationId: 'conv-1',
    idempotencyKey: `key-${id}`,
    payload: { to: 'sarah@acme.com', subject: 'Hi', htmlBody: '<p>hi</p>' },
    schemaVersion: 1,
    status: 'PENDING',
    attempts: 0,
    createdAt: now,
    nextAttemptAt: now,
    ...over,
  };
}

const jobs = () =>
  Object.entries(store)
    .filter(([p]) => p.startsWith(QUEUE + '/'))
    .map(([, d]) => d as any);

const job = (id: string) => store[`${QUEUE}/${id}`] as any;

beforeEach(() => {
  store = {};
  interleave = null;
  beforeRead = null;
  transactionCount = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});

// ===========================================================================
/**
 * The harness before the subject. Every concurrency claim below rests on the double aborting a
 * transaction whose reads changed, and a double that quietly applied the writes instead would
 * let all of them pass while proving nothing. So the mechanism is asserted directly rather than
 * assumed from the tests that depend on it.
 */
describe('0. the datastore double aborts like the real one', () => {
  it('a transaction whose read changed before commit throws', async () => {
    // Cast: these call the DOUBLE, whose  takes a path string. The real signatures
    // describe a library this file has replaced.
    const { runTransaction, doc } = (await import('firebase/firestore')) as any;
    store['a/b'] = { v: 1 };

    interleave = () => {
      store['a/b'] = { v: 2 };
    };

    await expect(
      runTransaction({} as never, async (tx: any) => {
        await tx.get(doc('a/b'));
        tx.update(doc('a/b'), { v: 99 });
      })
    ).rejects.toThrow(/changed before commit/);

    // And the losing transaction's write was not applied.
    expect(store['a/b']).toEqual({ v: 2 });
  });

  it('an uncontended transaction commits', async () => {
    const { runTransaction, doc } = (await import('firebase/firestore')) as any;
    store['a/b'] = { v: 1 };
    await runTransaction({} as never, async (tx: any) => {
      await tx.get(doc('a/b'));
      tx.update(doc('a/b'), { v: 2 });
    });
    expect(store['a/b']).toEqual({ v: 2 });
  });

  it('a query filters by field and respects its limit, or the claim loop sees the wrong rows', async () => {
    const { getDocs, query, collection, where, limit } = (await import(
      'firebase/firestore'
    )) as any;
    seedJob('a');
    seedJob('b', { status: 'CANCELLED' });
    seedJob('c');
    const snap = await getDocs(
      query(collection({} as never, QUEUE), where('status', '==', 'PENDING'), limit(10))
    );
    expect(snap.docs.map((d: any) => d.id).sort()).toEqual(['a', 'c']);
  });
});

// ===========================================================================
describe('1. two workers, one job', () => {
  /**
   * The invariant S42 names first: two concurrent `processQueue` runs must produce exactly one
   * provider call. Claiming is what makes that true, so it is claiming that is tested — a job
   * claimed twice would be dispatched twice however careful the code after it is.
   */
  it('a job claimed by one worker cannot be claimed by another', async () => {
    seedJob('j1');

    const first = await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    const second = await outboxService.claimPendingJobs(ORG, 5, 'worker-b');

    expect(first.map((j) => j.id)).toEqual(['j1']);
    expect(second).toEqual([]);
    expect(job('j1').claimedBy).toBe('worker-a');
  });

  /**
   * The harder case, and the reason the double aborts on a changed read. Both workers see the
   * row as PENDING; the second commits while the first is inside its transaction. The first
   * must lose, and must lose by ABORTING rather than by overwriting.
   */
  it('a worker that read PENDING loses if another commits before it does', async () => {
    seedJob('j1');

    interleave = () => {
      store[`${QUEUE}/j1`] = {
        ...(store[`${QUEUE}/j1`] as any),
        status: 'CLAIMED',
        claimedBy: 'worker-b',
        leaseUntil: now + LEASE_MS,
        attempts: 1,
      };
    };

    const claimed = await outboxService.claimPendingJobs(ORG, 5, 'worker-a');

    expect(claimed).toEqual([]);
    expect(job('j1').claimedBy).toBe('worker-b');
  });

  /**
   * The window the abort cannot close, and the reason the in-transaction re-read exists.
   *
   * The candidate list is fetched OUTSIDE the transaction, so a row can be taken between the
   * query and the claim. Here the status changes before the transaction reads it, so the
   * transaction sees CLAIMED, records that as its snapshot, and commits without conflict. The
   * abort has nothing to catch. Only `data.status !== 'PENDING'` can refuse this.
   *
   * Written after a mutation run: removing that check left every other concurrency test here
   * passing, because the abort was covering for it. A guard covered by a different guard is not
   * a tested guard.
   */
  it('a row taken between the query and the transaction is refused by the re-read, not the abort', async () => {
    seedJob('j1');

    beforeRead = () => {
      store[`${QUEUE}/j1`] = {
        ...(store[`${QUEUE}/j1`] as any),
        status: 'CLAIMED',
        claimedBy: 'worker-b',
        leaseUntil: now + LEASE_MS,
        attempts: 1,
      };
    };

    const claimed = await outboxService.claimPendingJobs(ORG, 5, 'worker-a');

    expect(claimed).toEqual([]);
    expect(job('j1').claimedBy).toBe('worker-b');
    // The transaction ran and committed nothing, rather than never running or aborting.
    expect(transactionCount).toBe(1);
  });

  /** The same window, for backoff: only the in-transaction check can see this change. */
  it('a job that enters backoff between the query and the transaction is refused', async () => {
    seedJob('j1');

    beforeRead = () => {
      store[`${QUEUE}/j1`] = {
        ...(store[`${QUEUE}/j1`] as any),
        nextAttemptAt: now + 60_000,
      };
    };

    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
    expect(job('j1').status).toBe('PENDING');
  });

  it('the attempt counter moves exactly once per claim, not once per attempt to claim', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-b');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-c');
    expect(job('j1').attempts).toBe(1);
  });

  it('a claim carries the tenant, so the worker cannot dispatch under another one', async () => {
    seedJob('j1');
    const [claimed] = await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    expect(claimed.organizationId).toBe(ORG);
  });

  it('claims no more than it was asked for, even with more work available', async () => {
    for (let i = 0; i < 9; i++) seedJob(`j${i}`);
    const claimed = await outboxService.claimPendingJobs(ORG, 3, 'worker-a');
    expect(claimed).toHaveLength(3);
    expect(jobs().filter((j) => j.status === 'PENDING')).toHaveLength(6);
  });
});

// ===========================================================================
describe('2. a worker that dies mid-send', () => {
  /**
   * The crash S42 injects between the provider 200 and the status write. The job stays CLAIMED
   * and — this is the part that matters — is NOT immediately reclaimable. A queue that returned
   * it at once would re-send a message the provider had already accepted.
   */
  it('a crashed worker leaves the job CLAIMED and unclaimable while the lease is live', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    // worker-a dies here, after the provider returned 200 and before markProcessed.

    now += LEASE_MS - 1;
    expect(await outboxService.reapExpiredLeases(ORG)).toBe(0);
    expect(job('j1').status).toBe('CLAIMED');
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-b')).toEqual([]);
  });

  it('once the lease expires the job returns to PENDING rather than being stranded', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');

    now += LEASE_MS + 1;
    expect(await outboxService.reapExpiredLeases(ORG)).toBe(1);
    expect(job('j1').status).toBe('PENDING');
    expect(job('j1').claimedBy).toBeNull();
  });

  /**
   * And it comes back under backoff, not immediately. A job that returns to a claimable state
   * the instant its lease expires is a job a broken worker can spin on.
   */
  it('a reaped job is not claimable again until its backoff elapses', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    now += LEASE_MS + 1;
    await outboxService.reapExpiredLeases(ORG);

    expect(job('j1').nextAttemptAt).toBeGreaterThan(now);
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-b')).toEqual([]);

    now = job('j1').nextAttemptAt;
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-b')).toHaveLength(1);
  });

  /**
   * A worker that keeps dying must not retry forever. The ceiling is the same one `markFailed`
   * uses, so a job cannot outlive it by crashing rather than failing.
   */
  it('a job that has exhausted its attempts is dead-lettered by the reaper, not requeued', async () => {
    seedJob('j1', { attempts: MAX_ATTEMPTS, status: 'CLAIMED', leaseUntil: now - 1 });
    expect(await outboxService.reapExpiredLeases(ORG)).toBe(1);
    expect(job('j1').status).toBe('DEAD_LETTER');
  });
});

// ===========================================================================
describe('3. a provider that fails', () => {
  /**
   * A retryable failure — a 429, a 503, a timeout — must leave the job recoverable with its
   * attempt recorded. S42 states this one exactly: "a 429 leaves the job PENDING with
   * attempts=1".
   */
  it('a retryable failure returns the job to PENDING with the attempt counted', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    await outboxService.markFailed(ORG, 'j1', 'HTTP 429 from provider');

    expect(job('j1').status).toBe('PENDING');
    expect(job('j1').attempts).toBe(1);
    expect(job('j1').lastError).toContain('429');
  });

  it('each retry backs off further, so a failing provider is not hammered', async () => {
    seedJob('j1');
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      now = Math.max(now, job('j1').nextAttemptAt ?? now);
      await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
      await outboxService.markFailed(ORG, 'j1', 'HTTP 503');
      delays.push((job('j1').nextAttemptAt as number) - now);
    }
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
  });

  /**
   * A terminal failure is one retrying cannot fix — a stale draft, an unsupported payload
   * version, a human ownership lock. It must not go back into the queue at all.
   */
  it('a terminal failure goes straight to DEAD_LETTER and does not return to PENDING', async () => {
    seedJob('j1');
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    await outboxService.markFailed(ORG, 'j1', 'STALE_DRAFT: conversation moved', true);

    expect(job('j1').status).toBe('DEAD_LETTER');
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-b')).toEqual([]);
  });

  it('retrying past the ceiling dead-letters rather than looping', async () => {
    seedJob('j1', { attempts: MAX_ATTEMPTS });
    await outboxService.markFailed(ORG, 'j1', 'HTTP 503');
    expect(job('j1').status).toBe('DEAD_LETTER');
  });

  /** A dead letter is not silently discarded: the reason it stopped is on the row. */
  it('a dead letter records why and when', async () => {
    seedJob('j1');
    await outboxService.markFailed(ORG, 'j1', 'STALE_DRAFT: conversation moved', true);
    expect(job('j1').lastError).toContain('STALE_DRAFT');
    expect(job('j1').deadLetteredAt).toBeTypeOf('number');
  });
});

// ===========================================================================
describe('4. a queue that is not claimable', () => {
  /**
   * A job held for a human is not work the worker may take. This is the window P0.11 closed by
   * letting `queueMessage` set the status directly — the row is never PENDING at any point —
   * and it is asserted here from the claiming side.
   */
  it('a HUMAN_REVIEW job is never claimed', async () => {
    seedJob('j1', { status: 'HUMAN_REVIEW', heldReason: 'needs a human' });
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
  });

  it('a CANCELLED or PROCESSED job is never claimed', async () => {
    seedJob('j1', { status: 'CANCELLED' });
    seedJob('j2', { status: 'PROCESSED' });
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
  });

  it('a job under backoff is skipped until its time comes', async () => {
    seedJob('j1', { nextAttemptAt: now + 60_000 });
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
    now += 60_001;
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toHaveLength(1);
  });

  /**
   * And it is skipped without opening a transaction.
   *
   * The candidate-level check and the in-transaction one are both real, and each hides the
   * other from a mutation: remove either and the remaining one still produces the right answer.
   * The difference they do not hide is cost — a queue of backed-off jobs would open a
   * transaction per job per tick against a provider that is already failing.
   */
  it('a backed-off job costs no transaction', async () => {
    seedJob('j1', { nextAttemptAt: now + 60_000 });
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    expect(transactionCount).toBe(0);

    now += 60_001;
    await outboxService.claimPendingJobs(ORG, 5, 'worker-a');
    expect(transactionCount).toBe(1);
  });

  /**
   * The queue is per tenant. A worker serving one organisation must not be able to claim
   * another's work, whatever ids it knows.
   */
  it('a job in another tenant is invisible', async () => {
    store[`organizations/other-org/outbox/j1`] = {
      id: 'j1',
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
    };
    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
  });
});
