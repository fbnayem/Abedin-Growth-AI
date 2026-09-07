import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  attributionFor,
  mayActUnattributed,
  operatorActionRecord,
  operatorGate,
  requeueReasonFrom,
  requeueTargetFor,
  writeOperatorAction,
  OPERATOR_ACTIONS,
} from '../domain/operatorAction';
import { OUTBOX_JOB } from '../domain/stateMachines';

/**
 * S38 — WHO DID THAT, AND HOW DOES A JOB COME BACK?
 *
 * Two gaps, both of which only appear during an incident.
 *
 * Approve wrote `approvedBy` and `approvedAt` onto the job. That is attribution and it is not a
 * trail: the next approval overwrites it, a rejection recorded nothing comparable, and "what has
 * anyone done to this queue" had no answer that did not involve reading every row and inferring.
 * `actionLogs` exists, and is written by the gateway for actions it dispatched — not for
 * decisions a human made.
 *
 * And there was no way back from DEAD_LETTER at all. A job that exhausted its attempts, or was
 * refused for a stale draft, could only be recovered by an engineer editing the datastore by
 * hand — with, by construction, no record of who changed what. That is the worst case S38
 * describes, and it is reached by an operator doing the right thing.
 */

const service = readFileSync('server/services/outbox.service.ts', 'utf8');
const routes = readFileSync('server/routes/outbox.routes.ts', 'utf8');

// ===========================================================================
describe('1. an unattributed action is not an action by "unknown-operator"', () => {
  it('reads an identity from email, then uid', () => {
    expect(attributionFor({ email: 'ops@acme.com', uid: 'u1' })).toEqual({
      kind: 'IDENTIFIED',
      actor: 'ops@acme.com',
    });
    expect(attributionFor({ uid: 'u1' })).toEqual({ kind: 'IDENTIFIED', actor: 'u1' });
  });

  /**
   * The fallback that used to be here was the string `'unknown-operator'`, which sits in a log
   * looking exactly like an account name. There is no `actor` on the unattributed arm at all,
   * so a caller cannot read one off a record that does not have one.
   */
  it('produces no actor at all when there is no identity', () => {
    for (const claims of [null, undefined, {}, { email: '' }, { email: '   ', uid: '' }]) {
      const attribution = attributionFor(claims);
      expect(attribution.kind).toBe('UNATTRIBUTED');
      expect('actor' in attribution).toBe(false);
    }
  });

  /**
   * A claim arriving as an object would stringify to `[object Object]` and sit in the log
   * looking like an account name — the same failure as the placeholder, arrived at differently.
   */
  it('refuses an identity that is not a string', () => {
    for (const bad of [{ email: {} }, { uid: 42 }, { email: [], uid: null }]) {
      expect(attributionFor(bad).kind).toBe('UNATTRIBUTED');
    }
  });

  it('trims, so whitespace around an address does not become a distinct operator', () => {
    expect(attributionFor({ email: '  ops@acme.com  ' })).toEqual({
      kind: 'IDENTIFIED',
      actor: 'ops@acme.com',
    });
  });

  /** Releasing a message to a customer is the moment attribution matters most. */
  it('an unattributed caller may never mutate the queue in production', () => {
    expect(mayActUnattributed(true)).toBe(false);
    expect(mayActUnattributed(false)).toBe(true);
  });
});

// ===========================================================================
describe('2. a record says what moved, or there is no record', () => {
  const base = {
    action: 'APPROVE' as const,
    organizationId: 'org-1',
    jobId: 'job-1',
    attribution: { kind: 'IDENTIFIED' as const, actor: 'ops@acme.com' },
    fromStatus: 'HUMAN_REVIEW',
    toStatus: 'PENDING',
    at: 1_700_000_000_000,
  };

  it('records the actor, the transition and the time', () => {
    expect(operatorActionRecord(base)).toEqual({
      action: 'APPROVE',
      organizationId: 'org-1',
      jobId: 'job-1',
      actor: 'ops@acme.com',
      attribution: 'IDENTIFIED',
      fromStatus: 'HUMAN_REVIEW',
      toStatus: 'PENDING',
      reason: null,
      at: 1_700_000_000_000,
    });
  });

  it('an unattributed record carries a null actor, never a placeholder', () => {
    const record = operatorActionRecord({
      ...base,
      attribution: { kind: 'UNATTRIBUTED', why: 'no identity on the request' },
    });
    expect(record.actor).toBeNull();
    expect(record.attribution).toBe('UNATTRIBUTED');
  });

  /**
   * A record saying HUMAN_REVIEW -> HUMAN_REVIEW is evidence that something was reviewed and
   * acted on, when nothing was. That is worse than no record, because the trail is what an
   * incident review believes.
   */
  it('refuses to record an action that moved nothing', () => {
    expect(() => operatorActionRecord({ ...base, toStatus: 'HUMAN_REVIEW' })).toThrow(
      /moved nothing/
    );
  });

  it('refuses a record that does not name its organisation or job', () => {
    expect(() => operatorActionRecord({ ...base, organizationId: '' })).toThrow();
    expect(() => operatorActionRecord({ ...base, jobId: '' })).toThrow();
  });

  it('an empty reason is null, not an empty string that reads as an answer', () => {
    for (const reason of ['', '   ', null, undefined]) {
      expect(operatorActionRecord({ ...base, reason }).reason).toBeNull();
    }
    expect(operatorActionRecord({ ...base, reason: '  stale  ' }).reason).toBe('stale');
  });

  it('every action in the vocabulary can be recorded', () => {
    for (const action of OPERATOR_ACTIONS) {
      expect(operatorActionRecord({ ...base, action }).action).toBe(action);
    }
  });
});

// ===========================================================================
describe('3. a requeue does not re-send', () => {
  /**
   * The property that matters. PENDING is claimable by the worker on its next tick, so
   * requeueing a DEAD_LETTER job straight there would let one operator click re-send something
   * that had already failed five times or been refused as stale — with no second look.
   */
  it('a DEAD_LETTER job returns to HUMAN_REVIEW, not to PENDING', () => {
    const target = requeueTargetFor('DEAD_LETTER');
    expect(target.ok === true && target.toStatus).toBe('HUMAN_REVIEW');
  });

  /** And the shared transition map agrees, so the two cannot drift apart silently. */
  it('the transition map has no DEAD_LETTER -> PENDING edge to drift towards', () => {
    expect(OUTBOX_JOB.transitions.DEAD_LETTER).not.toContain('PENDING');
    expect(OUTBOX_JOB.transitions.DEAD_LETTER).toContain('HUMAN_REVIEW');
  });

  it('a FAILED job returns to PENDING, because it was already on its way there', () => {
    const target = requeueTargetFor('FAILED');
    expect(target.ok === true && target.toStatus).toBe('PENDING');
    expect(OUTBOX_JOB.transitions.FAILED).toContain('PENDING');
  });

  it('nothing else can be requeued, and the refusal says why', () => {
    for (const status of ['PENDING', 'CLAIMED', 'HUMAN_REVIEW', 'PROCESSED', 'CANCELLED']) {
      const target = requeueTargetFor(status);
      expect(target.ok).toBe(false);
      expect(target.ok === false && target.message).toContain(status);
    }
  });

  it('an unknown status is refused rather than treated as recoverable', () => {
    expect(requeueTargetFor('SOMETHING_NEW').ok).toBe(false);
    expect(requeueTargetFor('').ok).toBe(false);
  });

  /**
   * An operator asking for another try is not evidence that the previous five did not happen.
   * Resetting the counter would make the dead-letter ceiling unreachable by repeated clicking.
   */
  it('the requeue does not reset the attempt counter', () => {
    const body = service.slice(service.indexOf('  async requeue('), service.indexOf('/** Operator/inspection helper'));
    expect(body).not.toMatch(/attempts:\s*0/);
  });
});

// ===========================================================================
/**
 * The wiring. These read the source because exercising it needs Firestore, and what they pin is
 * the property that cannot be recovered afterwards: the record and the state change commit
 * together.
 */
/**
 * These three were source assertions until a mutation run showed what that is worth: turning
 * each guard into `if (false)` left every assertion about it passing, because the text the
 * assertion looked for was still there. The decisions moved into the domain module so they can
 * be called.
 */
describe('4. the guards are decisions, not conditions inside a handler', () => {
  it('an identified caller is allowed, in production and out of it', () => {
    for (const isProduction of [true, false]) {
      const gate = operatorGate({ email: 'ops@acme.com' }, isProduction);
      expect(gate.allowed).toBe(true);
      expect(gate.allowed === true && gate.attribution).toEqual({
        kind: 'IDENTIFIED',
        actor: 'ops@acme.com',
      });
    }
  });

  it('an unattributed caller is refused in production and permitted outside it', () => {
    expect(operatorGate({}, true).allowed).toBe(false);
    expect(operatorGate({}, false).allowed).toBe(true);
  });

  it('the refusal says why, because the caller has to be able to fix it', () => {
    const gate = operatorGate(null, true);
    expect(gate.allowed === false && gate.message).toMatch(/attributable to an operator/);
  });

  it('a requeue reason is required, and whitespace is not a reason', () => {
    for (const body of [undefined, null, {}, { reason: '' }, { reason: '   ' }, { reason: 7 }]) {
      expect(requeueReasonFrom(body).ok).toBe(false);
    }
    const given = requeueReasonFrom({ reason: '  provider outage, retrying  ' });
    expect(given.ok === true && given.reason).toBe('provider outage, retrying');
  });
});

// ===========================================================================
/**
 * The write itself, called rather than grepped for.
 */
describe('5. the audit write refuses when it cannot record', () => {
  const input = {
    action: 'REQUEUE' as const,
    organizationId: 'org-1',
    jobId: 'job-1',
    attribution: { kind: 'IDENTIFIED' as const, actor: 'ops@acme.com' },
    fromStatus: 'DEAD_LETTER',
    toStatus: 'HUMAN_REVIEW',
    reason: 'provider outage',
    at: 1_700_000_000_000,
  };

  /**
   * A queue change that succeeded while its record failed is a customer-facing change with
   * nothing saying who made it. The write throws, and the throw aborts the transaction the
   * caller is inside.
   */
  it('throws when there is nowhere to record the action', () => {
    const tx = { set: () => undefined };
    expect(() => writeOperatorAction(tx, null, input)).toThrow(/without leaving a record/);
  });

  it('writes exactly one record, through the transaction it was given', () => {
    const written: unknown[] = [];
    const tx = { set: (_ref: unknown, data: unknown) => written.push(data) };
    const record = writeOperatorAction(
      tx,
      { collection: 'c', newDocRef: () => 'ref' },
      input
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(record);
    expect(record.actor).toBe('ops@acme.com');
    expect(record.fromStatus).toBe('DEAD_LETTER');
    expect(record.toStatus).toBe('HUMAN_REVIEW');
  });

  /** A record that moved nothing must not be written at all, not written and then ignored. */
  it('writes nothing when the record would say nothing moved', () => {
    const written: unknown[] = [];
    const tx = { set: (_ref: unknown, data: unknown) => written.push(data) };
    expect(() =>
      writeOperatorAction(
        tx,
        { collection: 'c', newDocRef: () => 'ref' },
        { ...input, toStatus: 'DEAD_LETTER' }
      )
    ).toThrow(/moved nothing/);
    expect(written).toHaveLength(0);
  });
});

// ===========================================================================
describe('6. the wiring puts those decisions on the live path', () => {
  it('the audit write takes the caller transaction rather than opening its own', () => {
    expect(service).toMatch(/private writeOperatorAction\(\s*\n?\s*tx:/);
    expect(service).toMatch(/this\.writeOperatorAction\(tx, \{/);
  });

  it('every operator mutation writes one', () => {
    for (const action of ['APPROVE', 'REJECT', 'REQUEUE']) {
      expect(service).toContain(`action: '${action}'`);
    }
    expect(service.match(/this\.writeOperatorAction\(tx, \{/g)?.length).toBe(3);
  });

  /**
   * If the audit collection is unavailable the mutation is refused, rather than proceeding and
   * leaving a customer-facing change with nothing saying who made it.
   */
  it('the service delegates the refusal rather than restating it', () => {
    const body = service.slice(
      service.indexOf('private writeOperatorAction'),
      service.indexOf('async requeue(')
    );
    expect(body).toMatch(/writeOperatorAction\(/);
    // Passing null is what makes the domain function refuse; a service that resolved the
    // collection to something truthy on failure would never reach it.
    expect(body).toMatch(/actions === null \? null :/);
  });

  it('the routes refuse an unattributed mutation before calling the service', () => {
    for (const route of ['approve', 'reject', 'requeue']) {
      const at = routes.indexOf(`'/:id/${route}'`);
      expect(at).toBeGreaterThan(-1);
      const handler = routes.slice(at, at + 1400);
      expect(handler).toMatch(/attributedOrRefused\(req, res\)/);
      expect(handler).toMatch(/if \(attribution === null\) return;/);
    }
  });

  /**
   * Comments stripped: the docstring explaining the removal quotes the old expression, and a
   * check that cannot coexist with its own explanation gets the explanation deleted.
   */
  it('the placeholder operator name is gone from the code', () => {
    const code = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('unknown-operator');
    expect(code).toMatch(/operatorGate\(req\.user, isProduction\)/);
  });

  /** A requeue without a reason leaves the next operator the same question and no more data. */
  it('the requeue route asks the domain module whether a reason was given', () => {
    const at = routes.indexOf("'/:id/requeue'");
    const handler = routes.slice(at, at + 1400);
    expect(handler).toMatch(/requeueReasonFrom\(req\.body\)/);
    expect(handler).toMatch(/given\.ok === false/);
  });
});
