import { adjudicate, type CheckOutcome, type Finding, type Verdict } from './adjudication';

/**
 * S26 — the fourteen guards, as a decision that can be made before a message leaves.
 *
 * WHAT WAS THERE
 * --------------
 * `ActionGateway.dispatchAction` — the one real chokepoint — implemented a feature flag, an
 * ownership-lock read, a jurisdiction call, and, since P0.10, a suppression and consent check.
 * It implements **none** of: frequency cap, cooldown, quiet hours, daily recipient limit,
 * per-domain limit, sender quota, duplicate or conflicting campaign membership, active
 * conversation, pending human reply, wrong person, or existing customer.
 *
 * S26 records those as "moot for want of a send loop", and that is true of the campaign
 * scheduler — there isn't one. It is not true of the gateway, which every autonomous send
 * already passes through. A guard written when the loop is built is a guard written under
 * delivery pressure; this is the cheap moment.
 *
 * WHY A MISSING INPUT BLOCKS
 * --------------------------
 * This is the difference between this module and the independent auditor. The auditor reports
 * NOT_RUN and lets the gateway enforce, because the gateway is downstream of it. These guards
 * ARE the enforcement — there is nothing downstream — so a guard that cannot run is a guard
 * whose condition is unknown, and §14 is explicit that unknown must never resolve to
 * permission. "We could not tell whether it is 3am for this recipient" is not "it is not 3am".
 *
 * The consequence is deliberate and worth stating plainly: with the data this system currently
 * holds, several guards cannot run, so autonomous sending is REFUSED. That is the correct
 * failure direction. `REAL_EMAIL_SEND_ENABLED` is false and this system has never sent an
 * autonomous email, so nothing that works today stops working — what changes is that it will
 * not silently start working when the flag is flipped.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is not a campaign engine. There is no enrolment record, no per-contact sequence state and
 * no scheduler, and this does not add them. It is the gate such an engine would have to pass
 * through, available now to the one send path that exists.
 */

export const CAMPAIGN_GUARDS = [
  'SUPPRESSION',
  'HARD_BOUNCE',
  'SPAM_COMPLAINT',
  'WRONG_PERSON',
  'EXISTING_CUSTOMER',
  'ACTIVE_CONVERSATION',
  'PENDING_HUMAN_REPLY',
  'FREQUENCY_CAP',
  'COOLDOWN',
  'DUPLICATE_CAMPAIGN',
  'CONFLICTING_CAMPAIGN',
  'DAILY_RECIPIENT_LIMIT',
  'PER_DOMAIN_LIMIT',
  'QUIET_HOURS',
] as const;

export type CampaignGuard = (typeof CAMPAIGN_GUARDS)[number];

/**
 * What is known about a recipient and this send, at the moment of dispatch.
 *
 * Every field is optional and `undefined` means NOT KNOWN, which is distinct from a known
 * negative. `lastContactedAt: undefined` is "we have no contact history for this person"; it is
 * not "we have never contacted them", and only the second would license a send under a cooldown
 * rule. Where the two are genuinely different the type carries both — `everContacted` exists so
 * that "no history recorded" and "history recorded, and it is empty" can be told apart.
 */
export interface CampaignSafetyInput {
  /** Suppression flags from the live contact record. */
  readonly suppressed?: boolean;
  readonly hardBounced?: boolean;
  readonly complained?: boolean;
  /** Set when someone reported that this address does not belong to the intended person. */
  readonly wrongPerson?: boolean;
  /** A paying customer must not receive cold acquisition outreach. */
  readonly isExistingCustomer?: boolean;

  /** Whether an exchange with this contact is currently open. */
  readonly hasActiveConversation?: boolean;
  /** Whether a draft to this contact is sitting in HUMAN_REVIEW. */
  readonly hasPendingHumanReply?: boolean;

  /** Whether contact history was actually loaded. Distinguishes "none" from "not looked up". */
  readonly contactHistoryLoaded?: boolean;
  /** Sends to this contact inside the frequency window. */
  readonly sendsInWindow?: number;
  /** Milliseconds since the last send to this contact, when there was one. */
  readonly msSinceLastSend?: number | null;

  /** Campaign membership, when a campaign engine exists to supply it. */
  readonly campaignMembershipLoaded?: boolean;
  readonly alreadyInThisCampaign?: boolean;
  readonly inConflictingCampaign?: boolean;

  /** Organisation-wide counters for today. */
  readonly recipientsToday?: number;
  readonly sendsToThisDomainToday?: number;

  /** The recipient's local hour, 0-23, resolved from their own timezone. */
  readonly recipientLocalHour?: number;
}

/**
 * The limits. Named constants rather than literals at the comparison, so the number can be
 * argued with and changed in one place.
 */
export interface CampaignLimits {
  readonly maxSendsInWindow: number;
  readonly cooldownMs: number;
  readonly maxRecipientsPerDay: number;
  readonly maxPerDomainPerDay: number;
  /** Sending is permitted from this hour, inclusive, to `quietHoursStartHour`, exclusive. */
  readonly quietHoursEndHour: number;
  readonly quietHoursStartHour: number;
}

export const DEFAULT_LIMITS: CampaignLimits = Object.freeze({
  maxSendsInWindow: 3,
  cooldownMs: 3 * 24 * 60 * 60 * 1000,
  maxRecipientsPerDay: 200,
  maxPerDomainPerDay: 25,
  quietHoursEndHour: 8,
  quietHoursStartHour: 20,
});

export interface GuardResult {
  readonly guard: CampaignGuard;
  readonly outcome: CheckOutcome;
  readonly detail: string;
}

export interface CampaignSafetyDecision {
  readonly verdict: Verdict;
  readonly results: readonly GuardResult[];
  readonly findings: readonly Finding[];
  /** Guards that could not run. Never empty without every guard having had its input. */
  readonly notRun: readonly CampaignGuard[];
}

/** A guard whose input was absent. Recorded as NOT_RUN, which blocks. */
function notRun(guard: CampaignGuard, needs: string): GuardResult {
  return {
    guard,
    outcome: 'NOT_RUN',
    detail:
      `${needs} is not known, so this guard could not run. An unknown condition is not a ` +
      'satisfied one (§14).',
  };
}

const clean = (guard: CampaignGuard, detail: string): GuardResult => ({
  guard,
  outcome: 'CLEAN',
  detail,
});

const violated = (guard: CampaignGuard, detail: string): GuardResult => ({
  guard,
  outcome: 'VIOLATED',
  detail,
});

/**
 * A boolean flag that must be explicitly false to pass.
 *
 * `undefined` is NOT_RUN, not false. A contact record with no `hardBounced` field has not been
 * shown to be deliverable; it has been shown to be silent on the subject.
 */
function flagGuard(
  guard: CampaignGuard,
  value: boolean | undefined,
  needs: string,
  whenTrue: string
): GuardResult {
  if (value === undefined) return notRun(guard, needs);
  return value === true ? violated(guard, whenTrue) : clean(guard, `${needs} is false`);
}

/**
 * Evaluate every guard. Pure: no clock, no datastore, no environment.
 *
 * The recipient's local hour is passed in rather than computed, because computing it needs
 * their timezone and the wall clock — and a quiet-hours rule that reads the SERVER's clock is
 * the bug it exists to prevent (§30).
 */
export function evaluateCampaignSafety(
  input: CampaignSafetyInput,
  limits: CampaignLimits = DEFAULT_LIMITS
): CampaignSafetyDecision {
  const results: GuardResult[] = [
    flagGuard('SUPPRESSION', input.suppressed, 'the suppression flag', 'the recipient is suppressed'),
    flagGuard('HARD_BOUNCE', input.hardBounced, 'the hard-bounce flag', 'this address hard bounced'),
    flagGuard('SPAM_COMPLAINT', input.complained, 'the complaint flag', 'this recipient reported spam'),
    flagGuard(
      'WRONG_PERSON',
      input.wrongPerson,
      'the wrong-person flag',
      'this address was reported as not belonging to the intended person'
    ),
    flagGuard(
      'EXISTING_CUSTOMER',
      input.isExistingCustomer,
      'customer status',
      'the recipient is an existing customer and must not receive acquisition outreach'
    ),
    flagGuard(
      'ACTIVE_CONVERSATION',
      input.hasActiveConversation,
      'conversation state',
      'an exchange with this contact is open; a campaign message would talk over it'
    ),
    flagGuard(
      'PENDING_HUMAN_REPLY',
      input.hasPendingHumanReply,
      'the review queue for this contact',
      'a draft to this contact is awaiting human review'
    ),
  ];

  // ---- frequency and cooldown, both from contact history
  if (input.contactHistoryLoaded !== true) {
    results.push(notRun('FREQUENCY_CAP', 'contact history'));
    results.push(notRun('COOLDOWN', 'contact history'));
  } else {
    const sends = input.sendsInWindow ?? 0;
    results.push(
      sends >= limits.maxSendsInWindow
        ? violated(
            'FREQUENCY_CAP',
            `${sends} send(s) in the window; the cap is ${limits.maxSendsInWindow}`
          )
        : clean('FREQUENCY_CAP', `${sends} of ${limits.maxSendsInWindow} in the window`)
    );

    const since = input.msSinceLastSend;
    if (since === null || since === undefined) {
      // History was loaded and there is no previous send. Nothing to be too soon after.
      results.push(clean('COOLDOWN', 'no previous send to this contact'));
    } else if (since < limits.cooldownMs) {
      results.push(
        violated('COOLDOWN', `last send was ${Math.round(since / 3_600_000)}h ago; the cooldown is ${Math.round(limits.cooldownMs / 3_600_000)}h`)
      );
    } else {
      results.push(clean('COOLDOWN', `last send was ${Math.round(since / 3_600_000)}h ago`));
    }
  }

  // ---- campaign membership
  if (input.campaignMembershipLoaded !== true) {
    results.push(notRun('DUPLICATE_CAMPAIGN', 'campaign membership'));
    results.push(notRun('CONFLICTING_CAMPAIGN', 'campaign membership'));
  } else {
    results.push(
      input.alreadyInThisCampaign === true
        ? violated('DUPLICATE_CAMPAIGN', 'the contact is already enrolled in this campaign')
        : clean('DUPLICATE_CAMPAIGN', 'not already enrolled')
    );
    results.push(
      input.inConflictingCampaign === true
        ? violated('CONFLICTING_CAMPAIGN', 'the contact is enrolled in a conflicting campaign')
        : clean('CONFLICTING_CAMPAIGN', 'no conflicting enrolment')
    );
  }

  // ---- volume limits
  if (input.recipientsToday === undefined) {
    results.push(notRun('DAILY_RECIPIENT_LIMIT', "today's recipient count"));
  } else {
    results.push(
      input.recipientsToday >= limits.maxRecipientsPerDay
        ? violated(
            'DAILY_RECIPIENT_LIMIT',
            `${input.recipientsToday} recipients today; the limit is ${limits.maxRecipientsPerDay}`
          )
        : clean('DAILY_RECIPIENT_LIMIT', `${input.recipientsToday} of ${limits.maxRecipientsPerDay}`)
    );
  }

  if (input.sendsToThisDomainToday === undefined) {
    results.push(notRun('PER_DOMAIN_LIMIT', "today's per-domain count"));
  } else {
    results.push(
      input.sendsToThisDomainToday >= limits.maxPerDomainPerDay
        ? violated(
            'PER_DOMAIN_LIMIT',
            `${input.sendsToThisDomainToday} to this domain today; the limit is ${limits.maxPerDomainPerDay}`
          )
        : clean('PER_DOMAIN_LIMIT', `${input.sendsToThisDomainToday} of ${limits.maxPerDomainPerDay}`)
    );
  }

  // ---- quiet hours, in the RECIPIENT's local time
  const hour = input.recipientLocalHour;
  if (hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    results.push(notRun('QUIET_HOURS', "the recipient's local hour"));
  } else if (hour < limits.quietHoursEndHour || hour >= limits.quietHoursStartHour) {
    results.push(
      violated(
        'QUIET_HOURS',
        `it is ${hour}:00 for the recipient; sending is permitted from ` +
          `${limits.quietHoursEndHour}:00 to ${limits.quietHoursStartHour}:00`
      )
    );
  } else {
    results.push(clean('QUIET_HOURS', `it is ${hour}:00 for the recipient`));
  }

  // ---- adjudicate
  //
  // Every non-CLEAN outcome is BLOCKING, including NOT_RUN. There is no downstream control to
  // defer to: these guards are the last thing between a draft and a stranger's inbox.
  const findings: Finding[] = results
    .filter((r) => r.outcome !== 'CLEAN')
    .map((r) => ({
      check: r.guard,
      severity: 'BLOCKING' as const,
      detail: `${r.guard}: ${r.detail}`,
    }));

  return {
    verdict: adjudicate(findings),
    results,
    findings,
    notRun: results.filter((r) => r.outcome === 'NOT_RUN').map((r) => r.guard),
  };
}

/**
 * May this send proceed?
 *
 * One place, one answer. A caller cannot reach a send by checking a subset of the guards, and
 * cannot reach one at all unless every guard ran and every guard was clean.
 */
export function maySend(decision: CampaignSafetyDecision): boolean {
  return decision.verdict === 'PASS';
}

/** Why not, in one line an operator can act on. */
export function refusalReason(decision: CampaignSafetyDecision): string {
  if (decision.verdict === 'PASS') {
    throw new Error('[campaignSafety] refusalReason called for a decision that permits the send');
  }
  return decision.findings.map((f) => f.detail).join('; ');
}
