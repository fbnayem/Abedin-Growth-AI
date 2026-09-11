/**
 * P1.4 — STATE MACHINES.
 *
 * WHAT WAS WRONG
 * --------------
 * Nothing in this codebase knew which state changes were legal, so every one of them was.
 *
 *   - `POST /api/pipeline/:id/stage` wrote `req.body.stage` straight to the document. Any
 *     string became a pipeline stage. `stage: "won"`, `stage: ""`, `stage: {}` — all accepted,
 *     all persisted, all rendered.
 *   - A campaign could go from any status to any other, including out of a terminal one.
 *   - The signature webhook wrote `status: 'CONFIRMED'` on a meeting; a state gate was added
 *     under P0.14, but as a hand-rolled `terminal.includes(current)` list in one handler, so
 *     the same rule had to be remembered and re-written at every other call site.
 *   - The outbox gained its own approve/cancel gates under P1.2, again hand-rolled.
 *
 * Hand-rolled gates are the problem this module exists to remove. They are correct where
 * someone remembered to write one and absent everywhere else, and the absence is invisible.
 *
 * THE RULES
 * ---------
 * A transition is legal only if the map says so. Unknown entity, unknown current state,
 * unknown target state: all refused. That is §14 applied to state — "I do not recognise this"
 * must not resolve to "go ahead".
 *
 * A transition to the state a record is ALREADY in is reported separately (`NO_CHANGE`) rather
 * than as an error or a silent success. Pausing something already paused is the operator
 * getting what they asked for; it should not increment a version, and it should not look like
 * a conflict.
 *
 * Terminal states have no outgoing transitions. This is what stops a replayed or late webhook
 * resurrecting a cancelled meeting — the check is here, once, instead of in each handler.
 */

export type TransitionMap = Readonly<Record<string, readonly string[]>>;

export interface EntityStateMachine {
  readonly name: string;
  readonly initial: readonly string[];
  readonly transitions: TransitionMap;
  /**
   * A machine describing a MODE rather than a lifecycle, which legitimately has no terminal
   * state. Autopilot is the only one: it is disabled and re-enabled indefinitely and never
   * finishes. Everything else models a record that reaches an end, and a lifecycle with no
   * terminal state is a design mistake — so the exemption is declared here, on the machine,
   * rather than being a hole in the rule that checks it.
   */
  readonly cyclical?: true;
}

/** Every state the machine mentions, whether as a source or a target. */
export function legalStates(machine: EntityStateMachine): string[] {
  const states = new Set<string>(Object.keys(machine.transitions));
  for (const targets of Object.values(machine.transitions)) {
    for (const target of targets) states.add(target);
  }
  for (const state of machine.initial) states.add(state);
  return [...states].sort();
}

/**
 * Whether a record may be CREATED in this state.
 *
 * `assertTransition` answers "may this record move from A to B", and creation is neither — there is
 * no prior state to move from — so nothing asked this. `POST /api/campaigns` wrote
 * `status: "ACTIVE"` while `CAMPAIGN.initial` is `['DRAFT']`, and this machine says ACTIVE is
 * reachable only FROM draft. The machine and the creation path disagreed about where a record
 * starts, and only the machine was written down.
 */
export function isInitialState(machine: EntityStateMachine, state: unknown): boolean {
  return typeof state === 'string' && machine.initial.includes(state);
}

export function isTerminal(machine: EntityStateMachine, state: string): boolean {
  const outgoing = machine.transitions[state];
  return Array.isArray(outgoing) && outgoing.length === 0;
}

export type TransitionVerdict =
  | { ok: true; changed: true }
  | { ok: true; changed: false } // already in the target state
  | {
      ok: false;
      code: 'UNKNOWN_CURRENT_STATE' | 'UNKNOWN_TARGET_STATE' | 'TERMINAL_STATE' | 'ILLEGAL_TRANSITION';
      message: string;
    };

/**
 * The single question every mutation asks: may this record move from `from` to `to`?
 */
export function assertTransition(
  machine: EntityStateMachine,
  from: unknown,
  to: unknown
): TransitionVerdict {
  const states = legalStates(machine);

  if (typeof to !== 'string' || !states.includes(to)) {
    return {
      ok: false,
      code: 'UNKNOWN_TARGET_STATE',
      message:
        `${JSON.stringify(to)} is not a ${machine.name} state. ` +
        `Legal states: ${states.join(', ')}.`,
    };
  }

  if (typeof from !== 'string' || !states.includes(from)) {
    // A record whose current state is unrecognised is not a record we can reason about. It
    // predates the machine, or something wrote a value nothing validated. Either way the safe
    // answer is to refuse and let a human look, not to guess a starting point.
    return {
      ok: false,
      code: 'UNKNOWN_CURRENT_STATE',
      message:
        `Current ${machine.name} state ${JSON.stringify(from)} is not recognised, so no ` +
        `transition from it can be judged legal. Legal states: ${states.join(', ')}.`,
    };
  }

  if (from === to) return { ok: true, changed: false };

  if (isTerminal(machine, from)) {
    return {
      ok: false,
      code: 'TERMINAL_STATE',
      message: `${machine.name} is ${from}, which is terminal. It cannot move to ${to}.`,
    };
  }

  const allowed = machine.transitions[from] ?? [];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      code: 'ILLEGAL_TRANSITION',
      message:
        `${machine.name} cannot move from ${from} to ${to}. ` +
        `From ${from} the legal targets are: ${allowed.length ? allowed.join(', ') : '(none)'}.`,
    };
  }

  return { ok: true, changed: true };
}

// ---------------------------------------------------------------------------
// The machines.
// ---------------------------------------------------------------------------

/**
 * Outbound job lifecycle. Mirrors the states outbox.service.ts already writes, so the service's
 * hand-rolled gates can defer to this instead of restating it. Since S6's third pass they do:
 * `claimPendingJobs`, `reapExpiredLeases`, `markProcessed` and `markFailed` each ask this map
 * inside a transaction. The first three restated it by hand before, and the reaper did so on a
 * query snapshot with no transaction at all.
 *
 * PROCESSED is terminal because the message reached a provider: nothing later may claim it did
 * not. DEAD_LETTER is deliberately NOT terminal — an operator resolving a dead letter is the
 * whole point of having one — but its only exit is CANCELLED or a fresh HUMAN_REVIEW.
 */
export const OUTBOX_JOB: EntityStateMachine = {
  name: 'outbox job',
  initial: ['PENDING', 'HUMAN_REVIEW'],
  transitions: {
    // PROCESSED from PENDING exists for one case (S6): a worker whose lease expired can still
    // finish. The reaper returned the row to PENDING because it presumed that worker dead; the
    // provider then confirmed the send. What is true is that the message was delivered, and a
    // map that forbade recording it would leave a PENDING row carrying a provider id — the
    // duplicate-send shape, written into the schema. This edge is how a late completion tells
    // the truth. It is not licence to skip CLAIMED: `markProcessed` requires a provider message
    // id, and nothing else writes PROCESSED.
    PENDING: ['CLAIMED', 'HUMAN_REVIEW', 'CANCELLED', 'FAILED', 'DEAD_LETTER', 'PROCESSED'],
    HUMAN_REVIEW: ['PENDING', 'CANCELLED'],
    CLAIMED: ['PROCESSED', 'FAILED', 'DEAD_LETTER', 'PENDING'],
    FAILED: ['PENDING', 'DEAD_LETTER', 'CANCELLED'],
    DEAD_LETTER: ['HUMAN_REVIEW', 'CANCELLED'],
    PROCESSED: [],
    CANCELLED: [],
  },
};

/**
 * Campaign lifecycle. DRAFT is where a campaign is built; ACTIVE and PAUSED alternate;
 * COMPLETED is terminal.
 *
 * There is deliberately no ACTIVE -> DRAFT edge: a campaign that has sent to anyone cannot
 * become a draft again, because "draft" would then be a state in which recipients have
 * already been contacted.
 */
export const CAMPAIGN: EntityStateMachine = {
  name: 'campaign',
  initial: ['DRAFT'],
  // The vocabulary is Campaign['status'] from shared/domain/models.ts. No state is invented
  // here: a machine that admits a status the domain type does not declare would let a write
  // succeed that the UI cannot render.
  transitions: {
    DRAFT: ['ACTIVE'],
    ACTIVE: ['PAUSED', 'COMPLETED'],
    PAUSED: ['ACTIVE', 'COMPLETED'],
    COMPLETED: [],
  },
};

/**
 * The per-recipient chain the roadmap requires. This is the state that actually governs
 * whether a person receives another message, and it did not exist: campaigns had no recipient
 * records at all (see campaign_recipients in the schema, added under P1.2).
 *
 * REPLIED, UNSUBSCRIBED, BOUNCED and SUPPRESSED are terminal, and that is the point: a reply
 * or an unsubscribe must STOP the sequence, and the way to guarantee it is to make "send the
 * next step" impossible from those states rather than to remember a check before each send.
 */
export const CAMPAIGN_RECIPIENT: EntityStateMachine = {
  name: 'campaign recipient',
  initial: ['ENROLLED'],
  transitions: {
    ENROLLED: ['SENDING', 'SUPPRESSED', 'UNSUBSCRIBED', 'CANCELLED'],
    SENDING: ['AWAITING_NEXT_STEP', 'BOUNCED', 'FAILED', 'REPLIED', 'UNSUBSCRIBED'],
    AWAITING_NEXT_STEP: ['SENDING', 'REPLIED', 'UNSUBSCRIBED', 'COMPLETED', 'CANCELLED', 'SUPPRESSED'],
    FAILED: ['AWAITING_NEXT_STEP', 'CANCELLED'],
    COMPLETED: [],
    REPLIED: [],
    UNSUBSCRIBED: [],
    BOUNCED: [],
    SUPPRESSED: [],
    CANCELLED: [],
  },
};

/**
 * Pipeline stage. This replaces `req.body.stage` being written unvalidated.
 *
 * The vocabulary is `LeadStatus` from shared/domain/models.ts — the states the UI and the seed
 * data actually use. It is written out here rather than derived from the type because a legal
 * TRANSITION map is more than the set of legal values, and because the type is a union with no
 * runtime representation to check against.
 *
 * Backward movement is allowed one step. Deals genuinely regress, and refusing to record that
 * pushes operators into editing the datastore directly, which is worse than a recorded
 * regression.
 *
 * WON, LOST and UNSUBSCRIBED are terminal. UNSUBSCRIBED especially: a record cannot be moved
 * back into an active stage after the person has opted out, because every stage below it is
 * one that permits contact.
 */
export const OPPORTUNITY: EntityStateMachine = {
  name: 'opportunity stage',
  initial: ['NEW'],
  transitions: {
    NEW: ['QUALIFIED', 'CONTACTED', 'LOST', 'UNSUBSCRIBED'],
    QUALIFIED: ['CONTACTED', 'ENGAGED', 'LOST', 'UNSUBSCRIBED'],
    CONTACTED: ['ENGAGED', 'QUALIFIED', 'LOST', 'UNSUBSCRIBED'],
    ENGAGED: [
      'DEMO_SCHEDULED',
      'MEETING_SCHEDULED',
      'PROPOSAL',
      'PROPOSAL_SENT',
      'CONTACTED',
      'LOST',
      'UNSUBSCRIBED',
    ],
    DEMO_SCHEDULED: ['DEMO_COMPLETED', 'MEETING_SCHEDULED', 'ENGAGED', 'LOST', 'UNSUBSCRIBED'],
    MEETING_SCHEDULED: ['DEMO_COMPLETED', 'DEMO_SCHEDULED', 'ENGAGED', 'LOST', 'UNSUBSCRIBED'],
    DEMO_COMPLETED: ['PROPOSAL', 'PROPOSAL_SENT', 'PILOT', 'NEGOTIATION', 'LOST', 'UNSUBSCRIBED'],
    PROPOSAL: ['PROPOSAL_SENT', 'NEGOTIATION', 'DEMO_COMPLETED', 'LOST', 'UNSUBSCRIBED'],
    PROPOSAL_SENT: ['NEGOTIATION', 'PILOT', 'WON', 'PROPOSAL', 'LOST', 'UNSUBSCRIBED'],
    PILOT: ['NEGOTIATION', 'WON', 'LOST', 'UNSUBSCRIBED'],
    NEGOTIATION: ['WON', 'PROPOSAL_SENT', 'PILOT', 'LOST', 'UNSUBSCRIBED'],
    WON: [],
    LOST: [],
    UNSUBSCRIBED: [],
  },
};

/**
 * Meeting lifecycle. The terminal set is what stops a replayed signature webhook resurrecting
 * a meeting that has since been cancelled — the rule P0.14 wrote inline in one handler, now
 * available to every handler.
 *
 * The vocabulary is `MeetingStatus`, plus `SCHEDULED`. SCHEDULED is what `POST /api/meetings`
 * actually persists (server.ts) and it is NOT a member of the enum: the booking endpoint has
 * been writing a status the domain does not define. Since that value is in the live datastore
 * and the UI renders it, the machine recognises it rather than declaring existing meetings
 * unreadable. It has been added to MeetingStatus so the divergence stops here.
 */
export const MEETING: EntityStateMachine = {
  name: 'meeting',
  initial: ['PROPOSED', 'SCHEDULED'],
  transitions: {
    PROPOSED: ['SCHEDULED', 'PENDING_CLIENT_CONFIRMATION', 'PENDING_CALENDAR_CREATION', 'CONFIRMED', 'CANCELLED'],
    PENDING_CLIENT_CONFIRMATION: ['CONFIRMED', 'SCHEDULED', 'CANCELLED', 'NO_SHOW'],
    PENDING_CALENDAR_CREATION: ['CONFIRMED', 'SCHEDULED', 'CANCELLED'],
    SCHEDULED: ['CONFIRMED', 'PENDING_CLIENT_CONFIRMATION', 'CANCELLED', 'NO_SHOW', 'COMPLETED'],
    CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW', 'SCHEDULED'],
    COMPLETED: [],
    CANCELLED: [],
    NO_SHOW: [],
  },
};

/**
 * Knowledge approval lifecycle.
 *
 * Knowledge items are stringified into outbound prompts, so "who approved this text before it
 * could influence what a customer is told" is a real question the system could not answer:
 * items were written and read with no approval concept at all. APPROVED is the only state the
 * prompt assembler may read from (see P1.8).
 */
export const KNOWLEDGE_ITEM: EntityStateMachine = {
  name: 'knowledge item',
  initial: ['DRAFT'],
  transitions: {
    DRAFT: ['PENDING_REVIEW', 'ARCHIVED'],
    PENDING_REVIEW: ['APPROVED', 'REJECTED', 'DRAFT'],
    APPROVED: ['SUPERSEDED', 'ARCHIVED', 'PENDING_REVIEW'],
    REJECTED: ['DRAFT', 'ARCHIVED'],
    SUPERSEDED: ['ARCHIVED'],
    ARCHIVED: [],
  },
};

/**
 * Payment lifecycle.
 *
 * REQUIRES_ACTION and PROCESSING both exist because a provider result can be neither success
 * nor failure (§32). AMBIGUOUS is a first-class state rather than an error: a payment whose
 * outcome is unknown must be reconciled against the provider, and must never be retried on the
 * assumption it failed.
 */
export const PAYMENT: EntityStateMachine = {
  name: 'payment',
  initial: ['NOT_STARTED'],
  transitions: {
    NOT_STARTED: ['CHECKOUT_CREATED', 'CANCELLED'],
    CHECKOUT_CREATED: ['PROCESSING', 'CANCELLED', 'FAILED'],
    PROCESSING: ['SUCCEEDED', 'FAILED', 'AMBIGUOUS'],
    // §32 — AMBIGUOUS is a state, not an error. A charge whose outcome is unknown must be
    // reconciled against the provider; it must NEVER be retried on the assumption it failed,
    // which is how a customer is charged twice. There is deliberately no edge back to
    // PROCESSING.
    AMBIGUOUS: ['SUCCEEDED', 'FAILED'],
    FAILED: ['CHECKOUT_CREATED', 'CANCELLED'],
    SUCCEEDED: ['REFUNDED'],
    REFUNDED: [],
    CANCELLED: [],
  },
};

/**
 * Autopilot run state. Persisted rather than in-process, so a restart does not lose the fact
 * that a cycle was mid-flight.
 */
export const AUTOPILOT: EntityStateMachine = {
  name: 'autopilot',
  cyclical: true,
  initial: ['IDLE'],
  transitions: {
    IDLE: ['RUNNING', 'DISABLED'],
    RUNNING: ['IDLE', 'FAILED', 'HALTED'],
    FAILED: ['IDLE', 'DISABLED'],
    HALTED: ['IDLE', 'DISABLED'],
    DISABLED: ['IDLE'],
  },
};

export const MACHINES = {
  OUTBOX_JOB,
  CAMPAIGN,
  CAMPAIGN_RECIPIENT,
  OPPORTUNITY,
  MEETING,
  KNOWLEDGE_ITEM,
  PAYMENT,
  AUTOPILOT,
} as const;
