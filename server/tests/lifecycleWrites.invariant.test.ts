import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN,
  OUTBOX_JOB,
  assertTransition,
  isInitialState,
} from '../domain/stateMachines';
import { killSwitchGate } from '../domain/operatorAction';
import { orgPath } from '../tenancy/orgScope';

/**
 * INVARIANTS FOR THE TWO LIFECYCLE WRITES THAT DID NOT ASK THE MAP (S6).
 *
 * Eight machines are declared and `assertTransition` guards the outbox service and three handlers
 * in `server.ts`. Two writes did not go through it, and they failed in different ways.
 *
 * CREATION. `POST /api/campaigns` wrote `status: "ACTIVE"` while `CAMPAIGN.initial` is `['DRAFT']`,
 * and the machine says ACTIVE is reachable only FROM draft. So a campaign was born in a state the
 * machine describes as arrived-at, and the two disagreed about where a record starts. Creation is
 * not a transition — there is no prior state — so `assertTransition` could not have been asked;
 * the question `isInitialState` asks did not exist.
 *
 * THE KILL SWITCH. `setCircuitBreaker` cancelled every PENDING job with a direct `updateDoc`. The
 * write was legal — PENDING -> CANCELLED is in the map — but it was a second owner of the rule,
 * and it decided on data read BEFORE the write. A first fix asked `assertTransition` at that spot
 * and claimed it caught a row the worker had claimed in between. It did not: it asked about the
 * same query snapshot. That claim survived until this suite's second half was made behavioural,
 * which is the point of a behavioural suite. Cancellation now goes through the outbox service's
 * transactional `cancelJob`, which re-reads, asks the machine about what it just read, and leaves
 * an operator-action record in the same transaction.
 */

// ---------------------------------------------------------------------------------------------
// A document store with the transactional semantics that matter here, trimmed from the chaos
// suite. `betweenQueryAndReread` is the competing writer: it fires once, inside the next
// transaction, after the PENDING query has returned and before the transaction's own re-read.
// ---------------------------------------------------------------------------------------------
let store: Record<string, Record<string, unknown>> = {};
let betweenQueryAndReread: (() => void) | null = null;

const pathOf = (ref: any): string => ref.path;

vi.mock('../store', () => {
  class StoreError extends Error {}
  const has = (path: string) => Object.prototype.hasOwnProperty.call(store, path);
  return {
    store: {},
    getStore: () => ({}),
    resetStoreForTests: () => undefined,
    tenantOf: () => null,
    assertNoUndefined: () => undefined,
    compileQuery: () => ({ text: '', values: [] }),
    StorePathError: StoreError,
    StoreValueError: StoreError,
    collection: (_db: unknown, path: string) => ({ path }),
    doc: (first: any, ...rest: any[]) => {
      if (typeof first === 'string') return { path: [first, ...rest].join('/') };
      if (first && typeof first.path === 'string') return { path: [first.path, ...rest].join('/') };
      // `first` is the database handle; the path is whatever follows it.
      return { path: rest.join('/') };
    },
    getDoc: async (ref: any) => {
      const path = pathOf(ref);
      return { id: path.split('/').pop(), ref, exists: () => has(path), data: () => (has(path) ? { ...store[path] } : undefined) };
    },
    getDocs: async (q: any) => {
      const prefix = q.collectionPath + '/';
      const docs = Object.entries(store)
        .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .filter(([, data]) => q.filters.every((f: any) => (data as any)[f.field] === f.value))
        .map(([path, data]) => ({ id: path.slice(prefix.length), ref: { path }, data: () => ({ ...data }) }));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn: any) => docs.forEach(fn) };
    },
    query: (c: any, ...clauses: any[]) => ({
      collectionPath: c.path,
      filters: clauses.filter((x) => x.kind === 'where'),
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
    deleteDoc: async (ref: any) => {
      delete store[pathOf(ref)];
    },
    addDoc: async (c: any, value: any) => {
      const path = `${c.path}/added-${Object.keys(store).length}`;
      store[path] = { ...value };
      return { path };
    },
    runTransaction: async (_db: unknown, fn: any) => {
      const pendingSet: Record<string, Record<string, unknown>> = {};
      const pendingUpdate: Record<string, Record<string, unknown>> = {};
      const result = await fn({
        get: async (ref: any) => {
          if (betweenQueryAndReread) {
            const fire = betweenQueryAndReread;
            betweenQueryAndReread = null;
            fire();
          }
          const path = pathOf(ref);
          return { id: path.split('/').pop(), ref, exists: () => has(path), data: () => (has(path) ? { ...store[path] } : undefined) };
        },
        set: (ref: any, value: any) => {
          pendingSet[pathOf(ref)] = { ...value };
        },
        update: (ref: any, value: any) => {
          pendingUpdate[pathOf(ref)] = { ...(pendingUpdate[pathOf(ref)] ?? {}), ...value };
        },
        delete: () => undefined,
      });
      for (const [path, value] of Object.entries(pendingSet)) store[path] = value;
      for (const [path, value] of Object.entries(pendingUpdate)) {
        store[path] = { ...(store[path] ?? {}), ...value };
      }
      return result;
    },
  };
});

vi.mock('uuid', () => ({ v4: () => `uuid-${Object.keys(store).length}` }));
vi.mock('../tenancy/organizations', () => ({ listServiceableOrgIds: async () => ['org-a'] }));

const { setCircuitBreaker } = await import('../services/circuitBreaker.service');

const OUTBOX = orgPath('org-a', 'outbox');
const ACTIONS = orgPath('org-a', 'operatorActions');
const SETTINGS = 'system_settings/circuitBreaker';
const OPS = { kind: 'IDENTIFIED', actor: 'ops@acme.com' } as const;

const seed = (id: string, status: string) => {
  store[`${OUTBOX}/${id}`] = { status, to: 'someone@example.com' };
};
const job = (id: string) => store[`${OUTBOX}/${id}`];
const trail = () =>
  Object.entries(store)
    .filter(([path]) => path.startsWith(ACTIONS + '/'))
    .map(([, data]) => data);

const strip = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, '$1 ');

beforeEach(() => {
  store = {};
  betweenQueryAndReread = null;
  delete process.env.LEGACY_KILL_SWITCH_ORG_ID;
});

// =============================================================================================
describe('1. creation asks a question transitions cannot answer', () => {
  it('a campaign may only be created in a state the machine declares as initial', () => {
    expect(isInitialState(CAMPAIGN, 'DRAFT')).toBe(true);
    for (const arrived of ['ACTIVE', 'PAUSED', 'COMPLETED']) {
      expect(isInitialState(CAMPAIGN, arrived), arrived).toBe(false);
    }
  });

  it('a machine with two entry points accepts both', () => {
    // The other half: a predicate that only ever answered true for one state would pass above.
    expect(isInitialState(OUTBOX_JOB, 'PENDING')).toBe(true);
    expect(isInitialState(OUTBOX_JOB, 'HUMAN_REVIEW')).toBe(true);
    expect(isInitialState(OUTBOX_JOB, 'PROCESSED')).toBe(false);
  });

  it('and nothing that is not a declared state', () => {
    // Mutation note: dropping the `typeof state === 'string'` guard SURVIVES this test, and is
    // equivalent — `includes` compares with SameValueZero, so no non-string can equal a string
    // element. The guard exists for the type of `includes`'s parameter, not for behaviour, and
    // no assertion can tell the two apart. Recorded rather than papered over.
    for (const value of ['', 'draft', 'DRAFTS', null, undefined, 42, {}]) {
      expect(isInitialState(CAMPAIGN, value), JSON.stringify(value) ?? 'undefined').toBe(false);
    }
  });

  it('THE INVARIANT — the status the create handler writes is an initial state', () => {
    // Read out of the handler rather than hardcoded here: a copy in the test is exactly how the
    // machine and the creation path drifted apart in the first place.
    const source = readFileSync('server.ts', 'utf8');
    const literal = source.slice(source.indexOf('const newCampaign = {'));
    const status = literal.slice(0, literal.indexOf('\n      };')).match(/status:\s*"([A-Z_]+)"/);

    expect(status, 'no status literal found in the campaign create handler').toBeTruthy();
    expect(isInitialState(CAMPAIGN, status![1]), `campaigns are created as ${status![1]}`).toBe(true);
  });

  it('and the console can still activate it in one step', () => {
    // The behaviour change is deliberate and this is its cost: a new campaign is no longer born
    // ACTIVE. It must remain one click away, or the change breaks the surface it was meant to make
    // honest.
    expect(assertTransition(CAMPAIGN, 'DRAFT', 'ACTIVE').ok).toBe(true);
  });
});

// =============================================================================================
describe('2. engaging the kill switch cancels the queue through the one owner of the rule', () => {
  it('the machine facts this relies on', () => {
    expect(assertTransition(OUTBOX_JOB, 'PENDING', 'CANCELLED').ok).toBe(true);
    expect(assertTransition(OUTBOX_JOB, 'CLAIMED', 'CANCELLED').ok).toBe(false);
    expect(assertTransition(OUTBOX_JOB, 'PROCESSED', 'CANCELLED').ok).toBe(false);
    const again = assertTransition(OUTBOX_JOB, 'CANCELLED', 'CANCELLED');
    expect(again.ok === true && again.changed).toBe(false);
  });

  it('THE INVARIANT — every PENDING job is cancelled, attributed, and leaves a record', async () => {
    seed('j1', 'PENDING');
    seed('j2', 'PENDING');
    seed('j3', 'PROCESSED');

    const result = await setCircuitBreaker(false, 'incident 42', OPS);

    expect(result.accepted).toBe(true);
    expect(result.state.globalAutonomousSendEnabled).toBe(false);
    expect(result.queue).toEqual({ organisations: 1, cancelled: 2, refused: 0, failed: 0 });

    for (const id of ['j1', 'j2']) {
      expect(job(id).status, id).toBe('CANCELLED');
      expect(job(id).cancelledBy, id).toBe('ops@acme.com');
      expect(job(id).cancelledReason, id).toBe('incident 42');
    }
    // Terminal states are left alone: a delivered message is not un-delivered by a pause.
    expect(job('j3').status).toBe('PROCESSED');

    const actions = trail();
    expect(actions.map((a) => a.jobId).sort()).toEqual(['j1', 'j2']);
    for (const action of actions) {
      expect(action.fromStatus).toBe('PENDING');
      expect(action.toStatus).toBe('CANCELLED');
      expect(action.actor).toBe('ops@acme.com');
      expect(action.reason).toBe('incident 42');
    }
  });

  it('a job the worker claims between the query and the write is refused, not forced', async () => {
    seed('j1', 'PENDING');
    betweenQueryAndReread = () => {
      store[`${OUTBOX}/j1`] = { ...job('j1'), status: 'CLAIMED', claimedBy: 'worker-1' };
    };

    const result = await setCircuitBreaker(false, 'incident', OPS);

    // The pause itself stands regardless; what changes is the honesty of the count.
    expect(result.accepted).toBe(true);
    expect(result.queue).toEqual({ organisations: 1, cancelled: 0, refused: 1, failed: 0 });
    expect(job('j1').status).toBe('CLAIMED');
    expect('cancelledBy' in job('j1')).toBe(false);
    expect(trail()).toHaveLength(0);
  });

  it('a job somebody else cancelled in that window is not counted as this cancellation', async () => {
    seed('j1', 'PENDING');
    betweenQueryAndReread = () => {
      store[`${OUTBOX}/j1`] = { ...job('j1'), status: 'CANCELLED', cancelledBy: 'someone-else' };
    };

    const result = await setCircuitBreaker(false, 'incident', OPS);

    expect(result.queue?.cancelled).toBe(0);
    expect(result.queue?.refused).toBe(1);
    // Not overwritten: the record of who actually cancelled it survives.
    expect(job('j1').cancelledBy).toBe('someone-else');
    expect(trail()).toHaveLength(0);
  });

  it('an unattributed pause still stops the queue, and the trail says nobody could be named', async () => {
    seed('j1', 'PENDING');

    const result = await setCircuitBreaker(false, 'incident', {
      kind: 'UNATTRIBUTED',
      why: 'the request carried no identity',
    });

    expect(result.accepted).toBe(true);
    expect(result.queue?.cancelled).toBe(1);
    expect(job('j1').status).toBe('CANCELLED');
    expect(job('j1').cancelledBy).toBeNull();

    const [action] = trail();
    expect(action.attribution).toBe('UNATTRIBUTED');
    expect(action.actor).toBeNull();

    // The durable record carries the reason, and no placeholder that reads like an account name.
    const record = store[SETTINGS];
    expect(record.paused).toBe(true);
    expect('actor' in record).toBe(false);
    expect(record.unattributedBecause).toBe('the request carried no identity');
    expect(Object.values(record)).not.toContain('unattributed');
  });

  it('a named pause records the name, once, in the durable state', async () => {
    await setCircuitBreaker(false, 'incident', OPS);
    const record = store[SETTINGS];
    expect(record.actor).toBe('ops@acme.com');
    expect('unattributedBecause' in record).toBe(false);
  });

  it('resuming cancels nothing and reports no queue outcome', async () => {
    seed('j1', 'PENDING');

    const result = await setCircuitBreaker(true, undefined, OPS);

    expect(result.accepted).toBe(true);
    expect(result.queue).toBeUndefined();
    expect(job('j1').status).toBe('PENDING');
    expect(store[SETTINGS].paused).toBe(false);
    expect(trail()).toHaveLength(0);
  });
});

// =============================================================================================
describe('3. the cancel rule has one owner', () => {
  const breaker = strip('server/services/circuitBreaker.service.ts');

  it('the kill switch does not write outbox rows itself', () => {
    expect(breaker).not.toContain('updateDoc');
    expect(breaker).not.toMatch(/status:\s*['"]CANCELLED['"]/);
    expect(breaker).toContain('outboxService.cancelJob(');
  });

  it('that check would catch the direct write coming back', () => {
    const regressed = "await updateDoc(d.ref, { status: 'CANCELLED', cancelledBy: actor });";
    expect(regressed).toContain('updateDoc');
    expect(regressed).toMatch(/status:\s*['"]CANCELLED['"]/);
  });
});

// =============================================================================================
describe('4. the attribution gate is asymmetric', () => {
  it('a pause is never refused for want of an identity — in production too', () => {
    const gate = killSwitchGate('PAUSE', null, true);
    expect(gate.allowed).toBe(true);
    expect(gate.allowed && gate.attribution.kind).toBe('UNATTRIBUTED');
  });

  it('a pause by a named operator is attributed to them', () => {
    expect(killSwitchGate('PAUSE', { email: 'ops@acme.com' }, true)).toEqual({
      allowed: true,
      attribution: { kind: 'IDENTIFIED', actor: 'ops@acme.com' },
    });
  });

  it('a resume in production needs a name', () => {
    expect(killSwitchGate('RESUME', null, true).allowed).toBe(false);
    expect(killSwitchGate('RESUME', { email: '   ' }, true).allowed).toBe(false);
    expect(killSwitchGate('RESUME', { uid: 'u1' }, true)).toEqual({
      allowed: true,
      attribution: { kind: 'IDENTIFIED', actor: 'u1' },
    });
  });

  it('outside production an unattributed resume is allowed, as every other queue mutation is', () => {
    const gate = killSwitchGate('RESUME', null, false);
    expect(gate.allowed).toBe(true);
    expect(gate.allowed && gate.attribution.kind).toBe('UNATTRIBUTED');
  });

  it('and the route asks it with the directions the right way round', () => {
    // Comments stripped first: the handler's own comment quotes the old placeholder, and an
    // assertion that it is gone must not be satisfied by the sentence saying so.
    const source = strip('server.ts');
    const start = source.indexOf('"/api/inbox/circuit-breaker/toggle"');
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('\n  app.', start + 1));

    expect(handler).toContain("killSwitchGate(enabled ? 'RESUME' : 'PAUSE', req.user, isProduction)");
    expect(handler).toContain("sendError(req, res, 'ATTRIBUTION_REQUIRED'");
    expect(handler).not.toContain("'unattributed'");
    expect(handler).toContain('gate.attribution');
  });
});
