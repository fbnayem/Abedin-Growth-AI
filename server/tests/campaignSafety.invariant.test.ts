import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  CAMPAIGN_GUARDS,
  DEFAULT_LIMITS,
  evaluateCampaignSafety,
  maySend,
  refusalReason,
  type CampaignSafetyInput,
} from '../domain/campaignSafety';

/**
 * S26 — THE FOURTEEN GUARDS.
 *
 * `ActionGateway.dispatchAction` — the one real chokepoint — implemented a feature flag, an
 * ownership lock, a jurisdiction call and, since P0.10, suppression and consent. It implemented
 * **none** of: frequency cap, cooldown, quiet hours, daily recipient limit, per-domain limit,
 * duplicate or conflicting campaign membership, active conversation, pending human reply, wrong
 * person, or existing customer.
 *
 * The section records these as "moot for want of a send loop". That is true of the campaign
 * scheduler — there isn't one — and false of the gateway, which every autonomous send already
 * passes through.
 *
 * THE PROPERTY EVERYTHING ELSE HERE DEPENDS ON
 * --------------------------------------------
 * A guard whose input is missing is NOT_RUN, and NOT_RUN refuses. This is the one place where
 * that differs from the independent auditor, which reports NOT_RUN and defers to the gateway:
 * these guards ARE the enforcement, so there is nothing to defer to. "We could not tell whether
 * it is 3am for this recipient" is not "it is not 3am", and §14 forbids the second reading.
 */

/** Everything known and clean. The base each test spoils exactly one field of. */
const allClear: CampaignSafetyInput = {
  suppressed: false,
  hardBounced: false,
  complained: false,
  wrongPerson: false,
  isExistingCustomer: false,
  hasActiveConversation: false,
  hasPendingHumanReply: false,
  contactHistoryLoaded: true,
  sendsInWindow: 0,
  msSinceLastSend: null,
  campaignMembershipLoaded: true,
  alreadyInThisCampaign: false,
  inConflictingCampaign: false,
  recipientsToday: 0,
  sendsToThisDomainToday: 0,
  recipientLocalHour: 10,
};

const outcomeOf = (input: CampaignSafetyInput, guard: string) =>
  evaluateCampaignSafety(input).results.find((r) => r.guard === guard)?.outcome;

// ===========================================================================
describe('1. every guard runs, or the send is refused', () => {
  it('a fully known, clean recipient passes', () => {
    const decision = evaluateCampaignSafety(allClear);
    expect(decision.verdict).toBe('PASS');
    expect(maySend(decision)).toBe(true);
    expect(decision.notRun).toEqual([]);
  });

  it('all fourteen guards are evaluated, every time', () => {
    const decision = evaluateCampaignSafety(allClear);
    expect(decision.results).toHaveLength(CAMPAIGN_GUARDS.length);
    expect(decision.results.map((r) => r.guard).sort()).toEqual([...CAMPAIGN_GUARDS].sort());
  });

  /**
   * The invariant. An empty input is the state this system is actually in for several of these,
   * and it must refuse rather than pass.
   */
  it('an empty input refuses, and names every guard that could not run', () => {
    const decision = evaluateCampaignSafety({});
    expect(maySend(decision)).toBe(false);
    expect(decision.notRun.length).toBeGreaterThan(0);
    expect(decision.verdict).toBe('BLOCK');
  });

  /**
   * Each guard, alone. A guard whose input is removed while every other guard stays clean must
   * still refuse — otherwise it is being carried by the others.
   */
  it.each([
    ['suppressed', 'SUPPRESSION'],
    ['hardBounced', 'HARD_BOUNCE'],
    ['complained', 'SPAM_COMPLAINT'],
    ['wrongPerson', 'WRONG_PERSON'],
    ['isExistingCustomer', 'EXISTING_CUSTOMER'],
    ['hasActiveConversation', 'ACTIVE_CONVERSATION'],
    ['hasPendingHumanReply', 'PENDING_HUMAN_REPLY'],
    ['recipientsToday', 'DAILY_RECIPIENT_LIMIT'],
    ['sendsToThisDomainToday', 'PER_DOMAIN_LIMIT'],
    ['recipientLocalHour', 'QUIET_HOURS'],
  ])('removing %s alone leaves %s NOT_RUN and refuses', (field, guard) => {
    const input = { ...allClear, [field]: undefined };
    expect(outcomeOf(input, guard)).toBe('NOT_RUN');
    expect(maySend(evaluateCampaignSafety(input))).toBe(false);
  });

  it('unloaded contact history stops both guards that depend on it', () => {
    const input = { ...allClear, contactHistoryLoaded: false };
    expect(outcomeOf(input, 'FREQUENCY_CAP')).toBe('NOT_RUN');
    expect(outcomeOf(input, 'COOLDOWN')).toBe('NOT_RUN');
    expect(maySend(evaluateCampaignSafety(input))).toBe(false);
  });

  it('unloaded campaign membership stops both guards that depend on it', () => {
    const input = { ...allClear, campaignMembershipLoaded: false };
    expect(outcomeOf(input, 'DUPLICATE_CAMPAIGN')).toBe('NOT_RUN');
    expect(outcomeOf(input, 'CONFLICTING_CAMPAIGN')).toBe('NOT_RUN');
    expect(maySend(evaluateCampaignSafety(input))).toBe(false);
  });
});

// ===========================================================================
describe('2. each guard refuses what it exists to refuse', () => {
  it.each([
    ['suppressed', 'SUPPRESSION'],
    ['hardBounced', 'HARD_BOUNCE'],
    ['complained', 'SPAM_COMPLAINT'],
    ['wrongPerson', 'WRONG_PERSON'],
    ['isExistingCustomer', 'EXISTING_CUSTOMER'],
    ['hasActiveConversation', 'ACTIVE_CONVERSATION'],
    ['hasPendingHumanReply', 'PENDING_HUMAN_REPLY'],
    ['alreadyInThisCampaign', 'DUPLICATE_CAMPAIGN'],
    ['inConflictingCampaign', 'CONFLICTING_CAMPAIGN'],
  ])('%s true violates %s', (field, guard) => {
    const input = { ...allClear, [field]: true };
    expect(outcomeOf(input, guard)).toBe('VIOLATED');
    expect(maySend(evaluateCampaignSafety(input))).toBe(false);
  });

  it('the frequency cap fires at the limit, not one past it', () => {
    const at = { ...allClear, sendsInWindow: DEFAULT_LIMITS.maxSendsInWindow };
    const under = { ...allClear, sendsInWindow: DEFAULT_LIMITS.maxSendsInWindow - 1 };
    expect(outcomeOf(at, 'FREQUENCY_CAP')).toBe('VIOLATED');
    expect(outcomeOf(under, 'FREQUENCY_CAP')).toBe('CLEAN');
  });

  it('the cooldown fires below the window and clears at it', () => {
    const inside = { ...allClear, msSinceLastSend: DEFAULT_LIMITS.cooldownMs - 1 };
    const at = { ...allClear, msSinceLastSend: DEFAULT_LIMITS.cooldownMs };
    expect(outcomeOf(inside, 'COOLDOWN')).toBe('VIOLATED');
    expect(outcomeOf(at, 'COOLDOWN')).toBe('CLEAN');
  });

  /**
   * History loaded and no previous send is genuinely clean — there is nothing to be too soon
   * after. This is the one case where a null is an answer rather than an absence, and it is only
   * an answer because `contactHistoryLoaded` says somebody looked.
   */
  it('no previous send is clean, but only when the history was actually loaded', () => {
    expect(outcomeOf({ ...allClear, msSinceLastSend: null }, 'COOLDOWN')).toBe('CLEAN');
    expect(
      outcomeOf({ ...allClear, contactHistoryLoaded: false, msSinceLastSend: null }, 'COOLDOWN')
    ).toBe('NOT_RUN');
  });

  it('the daily and per-domain limits fire at their limits', () => {
    expect(
      outcomeOf({ ...allClear, recipientsToday: DEFAULT_LIMITS.maxRecipientsPerDay }, 'DAILY_RECIPIENT_LIMIT')
    ).toBe('VIOLATED');
    expect(
      outcomeOf({ ...allClear, sendsToThisDomainToday: DEFAULT_LIMITS.maxPerDomainPerDay }, 'PER_DOMAIN_LIMIT')
    ).toBe('VIOLATED');
  });
});

// ===========================================================================
describe('3. quiet hours are the recipient\'s, and are not a server clock', () => {
  it('refuses before the start of the day and after the end of it', () => {
    for (const hour of [0, 3, 7, 20, 23]) {
      expect(outcomeOf({ ...allClear, recipientLocalHour: hour }, 'QUIET_HOURS')).toBe('VIOLATED');
    }
  });

  it('permits the working day, at both boundaries', () => {
    for (const hour of [8, 12, 19]) {
      expect(outcomeOf({ ...allClear, recipientLocalHour: hour }, 'QUIET_HOURS')).toBe('CLEAN');
    }
  });

  /**
   * The hour is passed in, not computed. A quiet-hours rule that reads the SERVER's clock sends
   * at 3am to anyone in a different timezone, which is the bug it exists to prevent (§30).
   */
  it('an hour that is not a real hour is NOT_RUN rather than coerced', () => {
    for (const hour of [-1, 24, 9.5, NaN]) {
      expect(outcomeOf({ ...allClear, recipientLocalHour: hour }, 'QUIET_HOURS')).toBe('NOT_RUN');
    }
  });
});

// ===========================================================================
describe('4. the decision cannot be reached by checking a subset', () => {
  it('maySend is true only when every guard is CLEAN', () => {
    const decision = evaluateCampaignSafety(allClear);
    expect(decision.results.every((r) => r.outcome === 'CLEAN')).toBe(true);
    expect(maySend(decision)).toBe(true);
  });

  it('a single violation among thirteen clean guards still refuses', () => {
    expect(maySend(evaluateCampaignSafety({ ...allClear, complained: true }))).toBe(false);
  });

  it('every non-clean outcome is BLOCKING — there is no tradeable severity here', () => {
    const decision = evaluateCampaignSafety({});
    expect(decision.findings.every((f) => f.severity === 'BLOCKING')).toBe(true);
  });

  /**
   * `maySend` requires PASS, not merely "not BLOCK".
   *
   * Today every finding here is BLOCKING, so the two are the same and a mutant weakening this to
   * `!== 'BLOCK'` survived. They stop being the same the moment any guard is given a lesser
   * severity — which is one edit away, and is itself a mutant that dies. Two individually
   * survivable weakenings that together permit an unguarded send is exactly the pair worth
   * pinning apart.
   */
  it('only PASS permits a send — ESCALATE and REWRITE do not', () => {
    for (const verdict of ['ESCALATE', 'REWRITE', 'BLOCK'] as const) {
      expect(
        maySend({ verdict, results: [], findings: [], notRun: [] })
      ).toBe(false);
    }
    expect(maySend({ verdict: 'PASS', results: [], findings: [], notRun: [] })).toBe(true);
  });

  /** Returning a reason for a permitted send would let a caller refuse one by mistake. */
  it('refusalReason throws for a decision that permits the send', () => {
    expect(() => refusalReason(evaluateCampaignSafety(allClear))).toThrow();
  });

  it('a refusal names the guards, so an operator knows what to fix', () => {
    const reason = refusalReason(evaluateCampaignSafety({ ...allClear, suppressed: true }));
    expect(reason).toContain('SUPPRESSION');
  });
});

// ===========================================================================
/**
 * Wired at the chokepoint, or it is a module nothing calls — which is the state four of the
 * safety components in this repository were found in.
 */
describe('5. the gateway consults it before dispatching', () => {
  const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');

  it('evaluates campaign safety and refuses on anything but a pass', () => {
    expect(gateway).toMatch(/evaluateCampaignSafety\(\{/);
    expect(gateway).toMatch(/if \(maySend\(safety\) === false\)/);
    expect(gateway).toMatch(/errorCode: 'POLICY_BLOCKED'/);
  });

  /**
   * Scoped to the token fetch that THIS send path makes. `oauth_connections` is read from three
   * places in this file and the first is in an unrelated preflight, so an unscoped search
   * compares the guard against a line it was never going to precede.
   */
  it('the check happens before the provider token is fetched for this send', () => {
    const check = gateway.indexOf('maySend(safety)');
    expect(check).toBeGreaterThan(-1);

    const tokenFetch = gateway.indexOf(
      "const q = query(collection(store, 'oauth_connections')"
    );
    expect(tokenFetch).toBeGreaterThan(-1);
    expect(check).toBeLessThan(tokenFetch);
  });

  /**
   * The three guards whose data does not exist are declared as not loaded, rather than being
   * passed a value that would make them pass. Claiming the history was loaded to get a green
   * guard is the defect this whole section is about.
   */
  it('does not claim to have data it has not loaded', () => {
    expect(gateway).toMatch(/contactHistoryLoaded: false/);
    expect(gateway).toMatch(/campaignMembershipLoaded: false/);
    expect(gateway).toMatch(/recipientLocalHour: undefined/);
  });

  /**
   * And the fields it DOES read are read as three states.
   *
   * `contactData.isExistingCustomer === true` collapses a record that is silent on customer
   * status into "not a customer", which is the §14 inversion in its smallest form: a missing
   * field becoming the permissive answer. Only `suppressed`, `hardBounced`, `complained` and
   * `wrongPerson` are read as two states, and deliberately — for those, absent and false are
   * both "no reason recorded not to send", and the gateway refuses separately when the contact
   * record does not exist at all.
   */
  it('reads a record silent on customer or conversation state as unknown, not as false', () => {
    for (const field of [
      'isExistingCustomer',
      'hasActiveConversation',
      'hasPendingHumanReply',
    ]) {
      expect(gateway).toMatch(
        new RegExp(
          `typeof contactData\\.${field} === 'boolean'[\\s\\S]{0,120}: undefined`
        )
      );
    }
  });
});
