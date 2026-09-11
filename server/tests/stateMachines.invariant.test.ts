import { LEAD_STATUSES } from '../../shared/domain/enums';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assertTransition,
  isTerminal,
  legalStates,
  MACHINES,
  CAMPAIGN,
  CAMPAIGN_RECIPIENT,
  MEETING,
  OPPORTUNITY,
  OUTBOX_JOB,
  PAYMENT,
  type EntityStateMachine,
} from '../domain/stateMachines';
import { MeetingStatus, PaymentStatus } from '../../shared/domain/models';

/**
 * INVARIANTS (addendum §6, §14, §26, §32 / P1.4).
 *
 * §6  A record moves only along a declared edge. Every other move is refused.
 * §14 An unrecognised state does not resolve to permission — not the current state, not the
 *     target state.
 * §26 A reply or an unsubscribe STOPS a campaign sequence. The mechanism is that those states
 *     are terminal, so "send the next step" is unreachable, rather than a check somebody has
 *     to remember before each send.
 * §32 An ambiguous provider result is a state to be reconciled, never retried as a failure.
 *
 * Before this module, `req.body.stage` was written straight to the document: any string was a
 * pipeline stage. The gates that did exist were hand-rolled per handler, which means they were
 * correct where someone remembered to write one and absent everywhere else.
 */

const ALL: [string, EntityStateMachine][] = Object.entries(MACHINES);

// ---------------------------------------------------------------------------
describe('§14 — unknown states never resolve to permission', () => {
  it('REFUSES an unrecognised target state', () => {
    for (const bad of ['won', '', 'ACTIVE_ISH', 'DROP TABLE', null, undefined, 42, {}]) {
      const verdict = assertTransition(OPPORTUNITY, 'NEW', bad);
      expect(verdict.ok, JSON.stringify(bad)).toBe(false);
      if (verdict.ok === false) expect(verdict.code).toBe('UNKNOWN_TARGET_STATE');
    }
  });

  it('REFUSES when the CURRENT state is unrecognised', () => {
    // A record holding a value nothing validated cannot be reasoned about. Guessing a starting
    // point would let exactly the records damaged by the old unvalidated writes move freely.
    const verdict = assertTransition(OPPORTUNITY, 'whatever-was-written-before', 'QUALIFIED');
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('UNKNOWN_CURRENT_STATE');
  });

  it('names the legal states in the refusal, so the caller can act on it', () => {
    const verdict = assertTransition(CAMPAIGN, 'ACTIVE', 'BOGUS');
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.message).toContain('PAUSED');
  });
});

// ---------------------------------------------------------------------------
describe('§6 — only declared edges are legal', () => {
  it('allows a declared edge', () => {
    const verdict = assertTransition(CAMPAIGN, 'ACTIVE', 'PAUSED');
    expect(verdict).toEqual({ ok: true, changed: true });
  });

  it('REFUSES an undeclared edge between two legal states', () => {
    // Both states are real; the move is not. This is the case a plain enum check misses.
    const verdict = assertTransition(CAMPAIGN, 'DRAFT', 'PAUSED');
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('ILLEGAL_TRANSITION');
  });

  it('reports a no-op transition as changed:false, not as an error', () => {
    // Pausing something already paused is the operator getting what they asked for. It must
    // not increment a version and must not look like a conflict.
    expect(assertTransition(CAMPAIGN, 'PAUSED', 'PAUSED')).toEqual({ ok: true, changed: false });
  });

  it('REFUSES to move out of a terminal state', () => {
    const verdict = assertTransition(MEETING, 'CANCELLED', 'CONFIRMED');
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('TERMINAL_STATE');
  });
});

// ---------------------------------------------------------------------------
describe('§6 — the specific rules the handlers depend on', () => {
  it('a replayed signature webhook cannot resurrect a cancelled meeting', () => {
    // The exact P0.14 scenario, now enforced by the shared map instead of one inline list.
    for (const terminal of ['CANCELLED', 'COMPLETED', 'NO_SHOW']) {
      const verdict = assertTransition(MEETING, terminal, 'CONFIRMED');
      expect(verdict.ok, terminal).toBe(false);
    }
  });

  it('a delivered message cannot be re-queued', () => {
    // PROCESSED means a provider accepted it. Nothing later may put it back in the send queue.
    for (const target of ['PENDING', 'CLAIMED', 'HUMAN_REVIEW']) {
      const verdict = assertTransition(OUTBOX_JOB, 'PROCESSED', target);
      expect(verdict.ok, target).toBe(false);
    }
  });

  it('a dead letter can still be resolved by an operator', () => {
    // Terminal-by-accident would make the dead-letter queue useless: its whole purpose is that
    // a human decides what happens next.
    expect(isTerminal(OUTBOX_JOB, 'DEAD_LETTER')).toBe(false);
    expect(assertTransition(OUTBOX_JOB, 'DEAD_LETTER', 'HUMAN_REVIEW').ok).toBe(true);
    expect(assertTransition(OUTBOX_JOB, 'DEAD_LETTER', 'CANCELLED').ok).toBe(true);
  });

  it('an opportunity cannot leave WON, LOST or UNSUBSCRIBED', () => {
    for (const terminal of ['WON', 'LOST', 'UNSUBSCRIBED']) {
      expect(isTerminal(OPPORTUNITY, terminal), terminal).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('§26 — a reply or an unsubscribe stops the sequence, structurally', () => {
  for (const stop of ['REPLIED', 'UNSUBSCRIBED', 'BOUNCED', 'SUPPRESSED']) {
    it(`${stop} is terminal, so no further step can be sent`, () => {
      expect(isTerminal(CAMPAIGN_RECIPIENT, stop)).toBe(true);
      // Specifically: the sending state is unreachable from it.
      const verdict = assertTransition(CAMPAIGN_RECIPIENT, stop, 'SENDING');
      expect(verdict.ok).toBe(false);
    });
  }

  it('a recipient can reach a stop state from every active state', () => {
    // If any active state lacked an edge to UNSUBSCRIBED, an unsubscribe arriving at that
    // moment could not be recorded, and the sequence would continue.
    for (const active of ['ENROLLED', 'SENDING', 'AWAITING_NEXT_STEP']) {
      const targets = CAMPAIGN_RECIPIENT.transitions[active];
      expect(targets, active).toContain('UNSUBSCRIBED');
    }
  });
});

// ---------------------------------------------------------------------------
describe('§32 — an ambiguous payment is reconciled, never retried', () => {
  it('AMBIGUOUS resolves only to a settled outcome', () => {
    expect([...PAYMENT.transitions.AMBIGUOUS].sort()).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('AMBIGUOUS cannot go back to PROCESSING', () => {
    // Retrying a charge whose outcome is unknown is how a customer is billed twice.
    const verdict = assertTransition(PAYMENT, 'AMBIGUOUS', 'PROCESSING');
    expect(verdict.ok).toBe(false);
  });

  it('PROCESSING can reach AMBIGUOUS at all', () => {
    // Without this edge there is nowhere to put a timed-out charge, and the code would be
    // forced to call it a failure.
    expect(PAYMENT.transitions.PROCESSING).toContain('AMBIGUOUS');
  });
});

// ---------------------------------------------------------------------------
describe('structural properties of every machine', () => {
  it('there are machines to check', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(8);
  });

  for (const [name, machine] of ALL) {
    it(`${name}: every state is a key in the transition map`, () => {
      // A state that appears only as a target has no declared outgoing edges, which
      // assertTransition would read as "terminal" — silently, and probably by accident.
      for (const state of legalStates(machine)) {
        expect(
          Object.prototype.hasOwnProperty.call(machine.transitions, state),
          `${name}: ${state} is a target but has no entry of its own`
        ).toBe(true);
      }
    });

    it(`${name}: every initial state is declared`, () => {
      for (const state of machine.initial) {
        expect(legalStates(machine), `${name}: ${state}`).toContain(state);
      }
    });

    it(`${name}: has at least one terminal state, unless declared cyclical`, () => {
      // A lifecycle with no terminal state describes a record that never finishes, which is
      // almost always an omission. AUTOPILOT is the genuine exception — a mode that is
      // disabled and re-enabled indefinitely — and it says so on the machine itself, so the
      // exemption is a deliberate declaration rather than a hole in this rule.
      const hasTerminal = legalStates(machine).some((s) => isTerminal(machine, s));
      if (machine.cyclical) {
        expect(hasTerminal, `${name} is declared cyclical but has a terminal state`).toBe(false);
      } else {
        expect(hasTerminal, name).toBe(true);
      }
    });

    it(`${name}: every state is reachable from an initial state`, () => {
      const reachable = new Set<string>(machine.initial);
      const queue = [...machine.initial];
      while (queue.length > 0) {
        const state = queue.shift()!;
        for (const next of machine.transitions[state] ?? []) {
          if (!reachable.has(next)) {
            reachable.add(next);
            queue.push(next);
          }
        }
      }
      const orphans = legalStates(machine).filter((s) => !reachable.has(s));
      expect(orphans, `${name}: unreachable states ${orphans.join(', ')}`).toEqual([]);
    });

    it(`${name}: no state declares itself as a target`, () => {
      // A self-edge is meaningless here: assertTransition answers same-state before it ever
      // consults the map, so a declared self-edge is dead configuration that misleads a reader.
      for (const [state, targets] of Object.entries(machine.transitions)) {
        expect(targets, `${name}: ${state} lists itself`).not.toContain(state);
      }
    });
  }
});

// ---------------------------------------------------------------------------
describe('the machines use the vocabulary the rest of the app uses', () => {
  it('MEETING states are all members of MeetingStatus', () => {
    // A runtime enum, so this genuinely cross-checks rather than restating a literal.
    const declared = new Set(Object.values(MeetingStatus) as string[]);
    for (const state of legalStates(MEETING)) {
      expect(declared.has(state), `${state} is not in MeetingStatus`).toBe(true);
    }
  });

  it('PAYMENT states are PaymentStatus plus the states §32 requires', () => {
    const declared = new Set([...(Object.values(PaymentStatus) as string[]), 'AMBIGUOUS', 'CANCELLED']);
    for (const state of legalStates(PAYMENT)) {
      expect(declared.has(state), `${state} is not in PaymentStatus`).toBe(true);
    }
  });

  it('OPPORTUNITY states are all members of the LeadStatus union', () => {
    // This parsed the union out of models.ts because "LeadStatus is a type-only union with no
    // runtime representation". That is no longer true: the members are a `const` list in
    // shared/domain/enums.ts and the type is derived from it, so this reads the list itself rather
    // than a regex over a file — which is what the old comment wanted and could not have.
    const declared = new Set<string>(LEAD_STATUSES);
    expect(declared.size).toBeGreaterThan(5);

    for (const state of legalStates(OPPORTUNITY)) {
      expect(declared.has(state), `${state} is not a LeadStatus`).toBe(true);
    }
  });

  it("CAMPAIGN states are all members of Campaign['status']", () => {
    const source = readFileSync('shared/domain/models.ts', 'utf8');
    const block = source.match(/export interface Campaign \{[\s\S]*?\n  status: ([^;]+);/);
    expect(block, "Campaign['status'] not found").toBeTruthy();

    const declared = new Set([...block![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
    for (const state of legalStates(CAMPAIGN)) {
      expect(declared.has(state), `${state} is not a Campaign status`).toBe(true);
    }
  });
});
