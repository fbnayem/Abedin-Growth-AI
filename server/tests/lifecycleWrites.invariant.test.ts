import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CAMPAIGN,
  KNOWLEDGE_ITEM,
  MEETING,
  OPPORTUNITY,
  OUTBOX_JOB,
  assertTransition,
  creationState,
  isInitialState,
  type EntityStateMachine,
} from '../domain/stateMachines';
import { killSwitchGate } from '../domain/operatorAction';
import { CURRENCIES } from '../../shared/domain/pricing';
import { orgPath } from '../tenancy/orgScope';
import { memory } from './helpers/memoryDocumentStore';

/**
 * INVARIANTS FOR THE LIFECYCLE WRITES THAT DID NOT ASK THE MAP (S6).
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
 *
 * The outbox service's OWN internal transitions are the subject of `outboxTransitions.invariant`.
 */

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
vi.mock('uuid', () => ({ v4: () => `uuid-${Object.keys(memory.docs).length}` }));
vi.mock('../tenancy/organizations', () => ({ listServiceableOrgIds: async () => ['org-a'] }));

const { setCircuitBreaker } = await import('../services/circuitBreaker.service');

const OUTBOX = orgPath('org-a', 'outbox');
const ACTIONS = orgPath('org-a', 'operatorActions');
const SETTINGS = 'system_settings/circuitBreaker';
const OPS = { kind: 'IDENTIFIED', actor: 'ops@acme.com' } as const;

const seed = (id: string, status: string) => {
  memory.docs[`${OUTBOX}/${id}`] = { status, to: 'someone@example.com' };
};
const job = (id: string) => memory.docs[`${OUTBOX}/${id}`];
const trail = () => Object.values(memory.collection(ACTIONS));

const strip = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/g, '$1 ');

beforeEach(() => {
  memory.reset();
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

  /**
   * Read out of each handler rather than hardcoded here: a copy in the test is exactly how the
   * machine and the creation path drifted apart in the first place. The anchor is a line unique
   * to the creation object; the first status literal after it is the one being asserted.
   */
  const creations: { what: string; machine: EntityStateMachine; file: string; anchor: string }[] = [
    { what: 'POST /api/campaigns', machine: CAMPAIGN, file: 'server/routes/campaigns.routes.ts', anchor: 'const newCampaign = {' },
    { what: 'POST /api/meetings', machine: MEETING, file: 'server/routes/meetings.routes.ts', anchor: 'id: "meet_" + Date.now(),' },
    { what: 'POST /api/knowledge', machine: KNOWLEDGE_ITEM, file: 'server/routes/knowledge.routes.ts', anchor: 'id: `kno_${Date.now()}`,' },
  ];

  for (const { what, machine, file, anchor } of creations) {
    it(`THE INVARIANT — ${what} creates its record in an initial state of ${machine.name}`, () => {
      const source = strip(file);
      const start = source.indexOf(anchor);
      expect(start, `anchor not found in ${file}: ${anchor}`).toBeGreaterThan(-1);
      const status = source.slice(start, start + 1500).match(/status:\s*['"]([A-Z_]+)['"]/);
      expect(status, `no status literal follows the anchor in ${file}`).toBeTruthy();
      expect(isInitialState(machine, status![1]), `${what} creates as ${status![1]}`).toBe(true);
    });
  }

  it('and the console can still activate a campaign in one step', () => {
    // The behaviour change is deliberate and this is its cost: a new campaign is no longer born
    // ACTIVE. It must remain one click away, or the change breaks the surface it was meant to make
    // honest.
    expect(assertTransition(CAMPAIGN, 'DRAFT', 'ACTIVE').ok).toBe(true);
  });

  /**
   * The fourth creation takes its state from the CALLER. `POST /api/pipeline` said "a supplied
   * stage is honoured only if it is a legal starting point" and checked `transitions[stage] !==
   * undefined` — whether the stage exists. Every legal stage was honoured; an opportunity could be
   * created WON. And the console defaulted to QUALIFIED because its board had no column for NEW.
   */
  describe('creation with a caller-supplied state', () => {
    it('absent means the first entry point', () => {
      for (const absent of [undefined, null, '']) {
        expect(creationState(OPPORTUNITY, absent)).toEqual({ ok: true, state: 'NEW' });
      }
    });

    it('an entry point is honoured', () => {
      expect(creationState(OPPORTUNITY, 'NEW')).toEqual({ ok: true, state: 'NEW' });
      expect(creationState(OUTBOX_JOB, 'HUMAN_REVIEW')).toEqual({ ok: true, state: 'HUMAN_REVIEW' });
    });

    it('THE INVARIANT — a legal stage that is not an entry point is refused, not substituted', () => {
      for (const arrived of ['QUALIFIED', 'PROPOSAL_SENT', 'WON']) {
        const verdict = creationState(OPPORTUNITY, arrived);
        expect(verdict.ok, arrived).toBe(false);
        expect(verdict.ok === false && verdict.message).toContain(`cannot be created as ${arrived}`);
      }
    });

    it('and a non-state is refused as such', () => {
      for (const junk of ['bogus', 'new', 42, {}]) {
        const verdict = creationState(OPPORTUNITY, junk);
        expect(verdict.ok, JSON.stringify(junk)).toBe(false);
        expect(verdict.ok === false && verdict.message).toContain('is not a');
      }
    });

    it('the pipeline handler asks it and refuses on its answer', () => {
      const source = strip('server/routes/pipeline.routes.ts');
      const start = source.indexOf("pipelineRouter.post('/'");
      expect(start).toBeGreaterThan(-1);
      const next = source.indexOf('\npipelineRouter.', start + 1);
      const handler = source.slice(start, next === -1 ? source.length : next);

      expect(handler).toContain('creationState(OPPORTUNITY, input.stage)');
      expect(handler).toContain("sendError(req, res, 'VALIDATION_ERROR', creation.message)");
      expect(handler).not.toContain('OPPORTUNITY.transitions[');
      expect(handler).not.toContain('OPPORTUNITY.initial[');
    });
  });

  describe('the console creates where the map says records start', () => {
    it('the new-opportunity modal sends no stage, and a currency the price book knows', () => {
      const modal = strip('src/components/NewOpportunityModal.tsx');
      const start = modal.indexOf('apiFetch("/api/pipeline", {');
      expect(start).toBeGreaterThan(-1);
      const request = modal.slice(start, modal.indexOf('});', start));

      expect(request).not.toMatch(/\bstage\b/);
      const currency = /currency:\s*"([A-Z]{3})"/.exec(request);
      expect(currency, 'the modal must send a three-letter currency code').not.toBeNull();
      expect(CURRENCIES as readonly string[]).toContain(currency![1]);
    });

    it('the board has a column for the entry point', () => {
      const board = strip('src/pages/PipelineView.tsx');
      expect(board).toMatch(/id:\s*"NEW"/);
    });
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
    memory.beforeTransactionRead = () => {
      memory.docs[`${OUTBOX}/j1`] = { ...job('j1'), status: 'CLAIMED', claimedBy: 'worker-1' };
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
    memory.beforeTransactionRead = () => {
      memory.docs[`${OUTBOX}/j1`] = { ...job('j1'), status: 'CANCELLED', cancelledBy: 'someone-else' };
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
    const record = memory.docs[SETTINGS];
    expect(record.paused).toBe(true);
    expect('actor' in record).toBe(false);
    expect(record.unattributedBecause).toBe('the request carried no identity');
    expect(Object.values(record)).not.toContain('unattributed');
  });

  it('a named pause records the name, once, in the durable state', async () => {
    await setCircuitBreaker(false, 'incident', OPS);
    const record = memory.docs[SETTINGS];
    expect(record.actor).toBe('ops@acme.com');
    expect('unattributedBecause' in record).toBe(false);
  });

  it('resuming cancels nothing and reports no queue outcome', async () => {
    seed('j1', 'PENDING');

    const result = await setCircuitBreaker(true, undefined, OPS);

    expect(result.accepted).toBe(true);
    expect(result.queue).toBeUndefined();
    expect(job('j1').status).toBe('PENDING');
    expect(memory.docs[SETTINGS].paused).toBe(false);
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
    const source = strip('server/routes/inbox.routes.ts');
    const start = source.indexOf("'/circuit-breaker/toggle'");
    expect(start).toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('\ninboxRouter.', start + 1));

    expect(handler).toContain("killSwitchGate(enabled ? 'RESUME' : 'PAUSE', req.user, isProduction)");
    expect(handler).toContain("sendError(req, res, 'ATTRIBUTION_REQUIRED'");
    expect(handler).not.toContain("'unattributed'");
    expect(handler).toContain('gate.attribution');
  });
});
