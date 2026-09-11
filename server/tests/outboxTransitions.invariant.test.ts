import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orgPath } from '../tenancy/orgScope';
import { memory } from './helpers/memoryDocumentStore';

/**
 * INVARIANTS FOR THE OUTBOX SERVICE'S OWN TRANSITIONS (S6, third pass).
 *
 * `assertTransition(OUTBOX_JOB, ...)` guarded `approveForSending`, `cancelJob` and `requeue`, and
 * a paragraph in the service said "every other transition on this collection goes through" it.
 * Four did not. `claimPendingJobs` restated the rule by hand (`status !== 'PENDING'`).
 * `markProcessed` was a bare `updateDoc` that wrote PROCESSED over whatever the row said.
 * `markFailed` re-read in a transaction and then wrote PENDING or DEAD_LETTER over anything —
 * a CANCELLED job included. And `reapExpiredLeases` wrote from a QUERY SNAPSHOT with no
 * transaction at all: a worker presumed dead because its lease expired, but which had in fact
 * just finished, had its PROCESSED job returned to PENDING — and sent again.
 *
 * That last one is the duplicate delivery the lease mechanism exists to prevent, arrived at
 * from the other side. PROCESSED is terminal in the map for exactly this reason; the map was
 * simply not asked.
 *
 * WHAT THE MAP DOES NOT CLOSE. Lease expiry is not proof of death. A reaped job can be
 * re-claimed and re-sent before its slow first worker records the delivery; the map keeps the
 * row truthful when that worker does (PENDING -> PROCESSED is legal for this case alone, and a
 * second provider id is recorded as `lateProviderMessageId`), and the gateway derives the
 * Message-ID from the idempotency key so the duplicate is at least detectable. It is not
 * prevented here, and this file does not claim it is.
 */

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
vi.mock('uuid', () => ({ v4: () => `uuid-${Object.keys(memory.docs).length}` }));

const { outboxService, MAX_ATTEMPTS, LEASE_MS } = await import('../services/outbox.service');

const ORG = 'org-a';
const OUTBOX = orgPath(ORG, 'outbox');
const T0 = 1_700_000_000_000;

const row = (id: string) => memory.docs[`${OUTBOX}/${id}`];
const seed = (id: string, fields: Record<string, unknown>) => {
  memory.docs[`${OUTBOX}/${id}`] = { id, organizationId: ORG, status: 'PENDING', attempts: 0, ...fields };
};
const expiredClaim = (attempts = 1) => ({
  status: 'CLAIMED',
  claimedBy: 'worker-a',
  leaseUntil: T0 - 1,
  attempts,
});
const payload: any = { to: 'someone@example.com', subject: 'hello', textBody: 'hi', htmlBody: '<p>hi</p>' };

const strip = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, '$1 ');

beforeEach(() => {
  memory.reset();
  vi.spyOn(Date, 'now').mockReturnValue(T0);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================================
describe('1. the reaper re-reads inside a transaction and asks the map', () => {
  it('an expired lease is returned to the queue with backoff, and dead-lettered past the ceiling', async () => {
    seed('j1', expiredClaim(1));
    seed('j2', expiredClaim(MAX_ATTEMPTS));

    expect(await outboxService.reapExpiredLeases(ORG)).toBe(2);

    expect(row('j1')).toMatchObject({ status: 'PENDING', claimedBy: null, leaseUntil: null });
    expect(row('j1').nextAttemptAt).toBeGreaterThan(T0);
    expect(row('j2')).toMatchObject({ status: 'DEAD_LETTER', leaseUntil: null });
  });

  it('THE INVARIANT — a job its slow worker finished between the query and the write is not sent again', async () => {
    seed('j1', expiredClaim(1));
    memory.beforeTransactionRead = () => {
      Object.assign(row('j1'), { status: 'PROCESSED', providerMessageId: 'prov-1', processedAt: T0, leaseUntil: null });
    };

    expect(await outboxService.reapExpiredLeases(ORG)).toBe(0);
    expect(row('j1')).toMatchObject({ status: 'PROCESSED', providerMessageId: 'prov-1' });
  });

  it('the map, not the lease field, is the authority', async () => {
    // A writer that moved the row to a terminal state and did not clear its lease. Today's
    // writers all clear it, which is why the lease re-read alone would already skip such a row;
    // the map's guarantee is the one that does not depend on every writer remembering to.
    seed('j1', expiredClaim(1));
    memory.beforeTransactionRead = () => {
      Object.assign(row('j1'), { status: 'PROCESSED', providerMessageId: 'prov-1' });
    };

    expect(await outboxService.reapExpiredLeases(ORG)).toBe(0);
    expect(row('j1').status).toBe('PROCESSED');
  });

  it("a job another worker re-claimed in the window keeps that worker's fresh lease", async () => {
    seed('j1', expiredClaim(1));
    memory.beforeTransactionRead = () => {
      Object.assign(row('j1'), { claimedBy: 'worker-b', leaseUntil: T0 + LEASE_MS, attempts: 2 });
    };

    expect(await outboxService.reapExpiredLeases(ORG)).toBe(0);
    expect(row('j1')).toMatchObject({ status: 'CLAIMED', claimedBy: 'worker-b', leaseUntil: T0 + LEASE_MS });
  });

  it('a refused row does not stop the reaper reaching the next one', async () => {
    seed('j1', expiredClaim(1));
    seed('j2', expiredClaim(1));
    memory.beforeTransactionRead = () => {
      Object.assign(row('j1'), { status: 'PROCESSED', providerMessageId: 'prov-1' });
    };

    expect(await outboxService.reapExpiredLeases(ORG)).toBe(1);
    expect(row('j1').status).toBe('PROCESSED');
    expect(row('j2').status).toBe('PENDING');
  });
});

// =============================================================================================
describe('2. recording a delivery tells the truth about where the row was', () => {
  it('from CLAIMED — the ordinary case', async () => {
    seed('j1', { status: 'CLAIMED', claimedBy: 'worker-a', leaseUntil: T0 + LEASE_MS, attempts: 1 });

    expect(await outboxService.markProcessed(ORG, 'j1', 'prov-1')).toEqual({ ok: true });
    expect(row('j1')).toMatchObject({
      status: 'PROCESSED',
      providerMessageId: 'prov-1',
      processedAt: T0,
      leaseUntil: null,
    });
  });

  it('from PENDING after a reap — delivered is delivered', async () => {
    seed('j1', { status: 'PENDING', claimedBy: null, leaseUntil: null, attempts: 1 });

    expect(await outboxService.markProcessed(ORG, 'j1', 'prov-1')).toEqual({ ok: true });
    expect(row('j1')).toMatchObject({ status: 'PROCESSED', providerMessageId: 'prov-1' });
  });

  it('THE INVARIANT — a second provider id for one job is evidence, not a second delivery', async () => {
    seed('j1', { status: 'PROCESSED', providerMessageId: 'prov-1', processedAt: T0 - 5 });

    const result = await outboxService.markProcessed(ORG, 'j1', 'prov-2');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.from).toBe('PROCESSED');
    expect(row('j1')).toMatchObject({
      status: 'PROCESSED',
      providerMessageId: 'prov-1',
      processedAt: T0 - 5,
      lateProviderMessageId: 'prov-2',
      lateProcessedFrom: 'PROCESSED',
    });
  });

  it('a job an operator cancelled after a reap keeps the decision and gains the evidence', async () => {
    seed('j1', { status: 'CANCELLED', cancelledBy: 'ops@acme.com' });

    const result = await outboxService.markProcessed(ORG, 'j1', 'prov-1');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.from).toBe('CANCELLED');
    expect(row('j1')).toMatchObject({ status: 'CANCELLED', cancelledBy: 'ops@acme.com', lateProviderMessageId: 'prov-1' });
    expect('providerMessageId' in row('j1')).toBe(false);
  });

  it('a job that no longer exists', async () => {
    expect(await outboxService.markProcessed(ORG, 'nope', 'prov-1')).toEqual({
      ok: false,
      from: 'MISSING',
      message: 'No such outbox job.',
    });
  });
});

// =============================================================================================
describe('3. recording a failure asks the map', () => {
  it('a retryable failure on a CLAIMED job returns it to the queue', async () => {
    seed('j1', { status: 'CLAIMED', claimedBy: 'worker-a', leaseUntil: T0 + LEASE_MS, attempts: 1 });

    await outboxService.markFailed(ORG, 'j1', 'provider 503');

    expect(row('j1')).toMatchObject({ status: 'PENDING', lastError: 'provider 503', claimedBy: null, leaseUntil: null });
    expect(row('j1').nextAttemptAt).toBeGreaterThan(T0);
  });

  it('THE INVARIANT — a failure reported for a CANCELLED job does not resurrect it', async () => {
    seed('j1', { status: 'CANCELLED', cancelledBy: 'ops@acme.com', attempts: 1 });

    await outboxService.markFailed(ORG, 'j1', 'provider 503');

    expect(row('j1').status).toBe('CANCELLED');
    expect('lastError' in row('j1')).toBe(false);
  });

  it('a terminal failure reported for a PROCESSED job does not dead-letter a delivered message', async () => {
    seed('j1', { status: 'PROCESSED', providerMessageId: 'prov-1', attempts: 1 });

    await outboxService.markFailed(ORG, 'j1', 'reconciliation disagreed', true);

    expect(row('j1').status).toBe('PROCESSED');
    expect('deadLetteredAt' in row('j1')).toBe(false);
  });
});

// =============================================================================================
describe('4. the claim and the enqueue ask the map', () => {
  it('a hold placed between the query and the transaction is respected', async () => {
    seed('j1', { status: 'PENDING', nextAttemptAt: T0 });
    memory.beforeTransactionRead = () => {
      Object.assign(row('j1'), { status: 'HUMAN_REVIEW', heldReason: 'an operator wants a look' });
    };

    expect(await outboxService.claimPendingJobs(ORG, 5, 'worker-a')).toEqual([]);
    expect(row('j1').status).toBe('HUMAN_REVIEW');
  });

  it('a job may only be enqueued in a state the map declares initial', async () => {
    await expect(
      outboxService.queueMessage(ORG, 'conv-1', payload, 'key-1', undefined, 'PROCESSED' as any)
    ).rejects.toThrow(/may be created in/);
    expect(Object.keys(memory.collection(OUTBOX))).toEqual([]);
  });

  it('and both declared entry points still work', async () => {
    const a = await outboxService.queueMessage(ORG, 'conv-1', payload, 'key-1');
    const b = await outboxService.queueMessage(ORG, 'conv-2', payload, 'key-2', undefined, 'HUMAN_REVIEW', 'needs eyes');

    expect(row(a!.id).status).toBe('PENDING');
    expect(row(b!.id)).toMatchObject({ status: 'HUMAN_REVIEW', heldReason: 'needs eyes' });
  });
});

// =============================================================================================
describe('5. every status write in the service sits behind the map', () => {
  const source = strip('server/services/outbox.service.ts');
  const starts = [...source.matchAll(/\n  (?:async |private |static )?([a-zA-Z_]+)\(/g)].map((m) => ({
    name: m[1],
    at: m.index!,
  }));
  const methods = starts.map((s, i) => ({
    name: s.name,
    body: source.slice(s.at, starts[i + 1]?.at ?? source.length),
  }));

  /**
   * A status WRITE is a `status:` key inside an object handed to a datastore write call — not a
   * query, not a parameter type, not a record field. The object may be inline, or built into a
   * variable first and passed by name: `claimPendingJobs` does the latter, and the first version
   * of this detector, which only looked after the call, did not see it. A detector that misses a
   * real writer is the blind spot the self-check below now covers.
   */
  const writesStatus = (body: string) => {
    for (const m of body.matchAll(/\b(tx\.update|tx\.set|setDoc|updateDoc)\(/g)) {
      const call = body.slice(m.index!, m.index! + 600);
      if (/\bstatus:/.test(call)) return true;
      const byName = /^\w+\.?\w*\(\s*[\w.]+,\s*(\w+)\s*\)/.exec(call);
      if (byName) {
        const literal = new RegExp('const ' + byName[1] + '\\s*=\\s*\\{[\\s\\S]{0,600}?\\bstatus:');
        if (literal.test(body)) return true;
      }
    }
    return false;
  };
  const writers = methods.filter(({ body }) => writesStatus(body));

  it('found the class', () => {
    expect(methods.length).toBeGreaterThanOrEqual(10);
  });

  it('the writers are exactly the eight this rule knows', () => {
    // A ninth writer must be added here consciously, with its guard.
    expect(writers.map((w) => w.name).sort()).toEqual([
      'approveForSending',
      'cancelJob',
      'claimPendingJobs',
      'markFailed',
      'markProcessed',
      'queueMessage',
      'reapExpiredLeases',
      'requeue',
    ]);
  });

  it('THE INVARIANT — each transition asks assertTransition, the creation asks isInitialState', () => {
    for (const { name, body } of writers) {
      if (name === 'queueMessage') {
        expect(body, name).toContain('isInitialState(OUTBOX_JOB');
      } else {
        expect(body, name).toContain('assertTransition(OUTBOX_JOB');
        expect(body, name).not.toContain('updateDoc(');
      }
    }
  });

  it('the write detector sees a write and not a query, a parameter, or a record field', () => {
    expect(writesStatus("tx.update(ref, { status: 'PENDING', x: 1 })")).toBe(true);
    expect(writesStatus('setDoc(ref, { id, status: initialStatus })')).toBe(true);
    // Built first, passed by name — the shape the claim uses and the first detector missed.
    expect(writesStatus("const update = { status: 'CLAIMED', attempts };\ntx.update(ref, update);")).toBe(true);
    expect(writesStatus('const update = { attempts };\ntx.update(ref, update);')).toBe(false);
    expect(writesStatus("getDocs(query(ref, where('status', '==', 'PENDING')))")).toBe(false);
    expect(writesStatus('async listByStatus(organizationId: string, status: string) {')).toBe(false);
    expect(writesStatus('tx.set(ref, { fromStatus: data.status, toStatus: target })')).toBe(false);
  });

  it('that rule would catch the old reaper coming back', () => {
    const regressed =
      "  async reapExpiredLeases(organizationId: string) {\n" +
      "    await updateDoc(d.ref, { status: 'PENDING', claimedBy: null });\n" +
      '  }';
    expect(writesStatus(regressed)).toBe(true);
    expect(regressed).not.toContain('assertTransition(OUTBOX_JOB');
  });
});
