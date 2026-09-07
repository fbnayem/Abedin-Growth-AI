import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  SEVERITIES,
  VERDICTS,
  adjudicate,
  checkPassed,
  findingFromReconciliation,
  dispositionFor,
  maySendAutonomously,
  outcomeFromViolation,
  reconcile,
  type Finding,
  type Opinion,
  type Severity,
  type Verdict,
} from '../domain/adjudication';
import { auditReplyAgainstPlan } from '../agents/independentAuditor';
import { BuyingStage, type ReplyPlan } from '../../shared/domain/models';

/**
 * S24 / P0.11 — DISAGREEMENT, AND A RECORD THAT DOES NOT LIE ABOUT WHAT RAN.
 *
 * Three defects are held closed here, and none of them is about whether the code compiles.
 *
 *  1. The auditor combined findings of different kinds by subtracting from 100 and
 *     thresholding, so severity was tradeable and BLOCK was unreachable from any content
 *     finding.
 *  2. Its `deterministicSafetyResult` was 24 compile-time literals across four return paths.
 *     Three of the six fields were `true` on ALL of them, so they could never be false in any
 *     execution — while the real values sat in scope, computed and unused.
 *  3. Nothing invoked it. The live pipeline called a local no-argument function that returned
 *     a frozen constant.
 */

const finding = (severity: Severity, check = 'c'): Finding => ({
  check,
  severity,
  detail: 'detail',
});

const RANK: Readonly<Record<Verdict, number>> = { PASS: 0, REWRITE: 1, ESCALATE: 2, BLOCK: 3 };

/**
 * The circuit breaker is module-level mutable state and defaults to OPEN (P0.2 — the master
 * autonomy switch fails closed, deliberately). Every audit therefore carries a
 * `circuit-breaker` finding unless a test closes it.
 *
 * The cases below are about the CONTENT controls, so they close it and restore the real
 * default afterwards. That the default is open is itself asserted, once, rather than
 * assumed: if it ever silently flips to `true`, this fails.
 */
import { circuitBreaker } from '../agents/salesDecisionEngine';

const BREAKER_DEFAULT = circuitBreaker.globalAutonomousSendEnabled;
const BREAKER_DEFAULT_REASON = circuitBreaker.pausedReason;

beforeEach(() => {
  circuitBreaker.globalAutonomousSendEnabled = true;
  circuitBreaker.pausedReason = undefined;
});

afterAll(() => {
  circuitBreaker.globalAutonomousSendEnabled = BREAKER_DEFAULT;
  circuitBreaker.pausedReason = BREAKER_DEFAULT_REASON;
});

describe('0. the state these tests run against', () => {
  it('autonomous sending is disabled by default, so the breaker finding is the norm', () => {
    expect(BREAKER_DEFAULT).toBe(false);
  });
});

// ===========================================================================
describe('1. adjudicate combines findings without arithmetic', () => {
  it('no findings is a PASS', () => {
    expect(adjudicate([])).toBe('PASS');
  });

  it('the verdict is the severity of the worst finding, whatever else is present', () => {
    expect(adjudicate([finding('ADVISORY')])).toBe('PASS');
    expect(adjudicate([finding('REWRITTEN')])).toBe('REWRITE');
    expect(adjudicate([finding('ESCALATING')])).toBe('ESCALATE');
    expect(adjudicate([finding('BLOCKING')])).toBe('BLOCK');
  });

  /**
   * The property the old `score -= n` could not have. Under subtraction, enough small
   * penalties reach any threshold: three findings worth 15 each cross the 90 line that one
   * worth 15 does not. Severity here is not a quantity, so it does not accumulate.
   */
  it('N findings of one severity never add up to a higher one', () => {
    for (const severity of SEVERITIES) {
      const alone = adjudicate([finding(severity)]);
      for (const n of [2, 3, 7, 40, 200]) {
        const many = adjudicate(Array.from({ length: n }, (_, i) => finding(severity, 'c' + i)));
        expect(many).toBe(alone);
      }
    }
  });

  it('a single severe finding is never diluted by any number of lesser ones', () => {
    const lesser = Array.from({ length: 500 }, (_, i) => finding('REWRITTEN', 'r' + i));
    expect(adjudicate([...lesser, finding('BLOCKING')])).toBe('BLOCK');
    expect(adjudicate([finding('BLOCKING'), ...lesser])).toBe('BLOCK');
  });

  /**
   * MONOTONE, exhaustively. Over every subset of the four severities and every superset of it,
   * adding findings never produces a less severe verdict. The old arithmetic satisfied this
   * only by the accident that every penalty happened to be negative.
   */
  it('adding a finding can never lower the verdict — all 16 subsets, all supersets', () => {
    const subsets: Severity[][] = [];
    for (let mask = 0; mask < 1 << SEVERITIES.length; mask++) {
      const s: Severity[] = [];
      for (let bit = 0; bit < SEVERITIES.length; bit++) {
        if (mask & (1 << bit)) s.push(SEVERITIES[bit]);
      }
      subsets.push(s);
    }
    expect(subsets.length).toBe(16);

    let pairsChecked = 0;
    for (const smaller of subsets) {
      for (const bigger of subsets) {
        const isSuperset = smaller.every((s) => bigger.includes(s));
        if (!isSuperset) continue;
        pairsChecked++;
        const a = adjudicate(smaller.map((s) => finding(s)));
        const b = adjudicate(bigger.map((s) => finding(s)));
        expect(RANK[b]).toBeGreaterThanOrEqual(RANK[a]);
      }
    }
    // Not a smoke test: 81 ordered subset pairs over a 4-element set.
    expect(pairsChecked).toBe(81);
  });

  it('the verdict does not depend on the order findings were pushed', () => {
    const list = [finding('ADVISORY'), finding('ESCALATING'), finding('REWRITTEN')];
    const reversed = [...list].reverse();
    const rotated = [list[1], list[2], list[0]];
    expect(adjudicate(list)).toBe('ESCALATE');
    expect(adjudicate(reversed)).toBe('ESCALATE');
    expect(adjudicate(rotated)).toBe('ESCALATE');
  });

  /**
   * A severity the module cannot rank must not be treated as harmless. `SEVERITIES.indexOf`
   * returns -1 for an unknown value, and -1 sorts below every real severity — so the natural
   * implementation would silently drop it and return PASS. That is S14 exactly: an unknown
   * value defaulting to permission.
   */
  it('an unrankable severity throws rather than being ignored', () => {
    const rogue = { check: 'x', severity: 'PROBABLY_FINE', detail: 'd' } as unknown as Finding;
    expect(() => adjudicate([rogue])).toThrow(/Unknown severity/);
    // And specifically: it must not quietly agree with the safe-looking answer.
    let verdict: Verdict | null = null;
    try {
      verdict = adjudicate([rogue]);
    } catch {
      verdict = null;
    }
    expect(verdict).toBeNull();
  });

  it('every severity maps to a verdict, and every verdict is reachable', () => {
    const reached = new Set(SEVERITIES.map((s) => adjudicate([finding(s)])));
    for (const v of VERDICTS) expect(reached.has(v)).toBe(true);
  });

  it('only PASS permits an autonomous send', () => {
    for (const v of VERDICTS) {
      expect(maySendAutonomously(v)).toBe(v === 'PASS');
    }
  });
});

// ===========================================================================
describe('1b. what a verdict means for the outbox', () => {
  /**
   * This mapping lived as two inline expressions inside `processNewEmail`, which needs
   * Firestore, a Gmail client and a resolved tenant to run — so nothing exercised it.
   * Mutation testing showed it: forcing every draft to PENDING, and deleting the BLOCK
   * branch outright, both left the entire gate green. Two survivors out of thirty-five, and
   * both of them the step that decides whether a customer receives an unreviewed email.
   *
   * Extracted, it is a total function over four inputs, so it can be checked exhaustively
   * rather than asserted about.
   */
  it('BLOCK is the only verdict that does not produce a durable row', () => {
    for (const verdict of VERDICTS) {
      const d = dispositionFor(verdict);
      expect(d.queue).toBe(verdict !== 'BLOCK');
    }
  });

  it('only PASS is queued at PENDING; everything else is held for a human', () => {
    for (const verdict of VERDICTS) {
      const d = dispositionFor(verdict);
      if (d.queue === true) {
        expect(d.status).toBe(verdict === 'PASS' ? 'PENDING' : 'HUMAN_REVIEW');
      }
    }
  });

  it('a REWRITE and an ESCALATE are both held, and neither is dropped', () => {
    for (const verdict of ['REWRITE', 'ESCALATE'] as const) {
      const d = dispositionFor(verdict);
      expect(d.queue).toBe(true);
      if (d.queue === true) expect(d.status).toBe('HUMAN_REVIEW');
    }
  });

  it('the mapping agrees with maySendAutonomously, so the two cannot drift', () => {
    for (const verdict of VERDICTS) {
      const d = dispositionFor(verdict);
      const pending = d.queue === true && d.status === 'PENDING';
      expect(pending).toBe(maySendAutonomously(verdict));
    }
  });

  /**
   * The pipeline branch itself is still only asserted through its source, because
   * `processNewEmail` is not constructible without a datastore. Recorded as the gap it is:
   * these two lines are the ones a behavioural test would cover if the pipeline were
   * testable, and making it so is separate work.
   */
  it('the pipeline reads the shared mapping rather than restating it', () => {
    const source = readFileSync('server/services/inboundPipeline.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\/:])\/\/[^\n]*/g, '$1');
    expect(source).toContain('dispositionFor(audit.decision)');
    expect(source).toContain('sendDisposition.queue === false');
    expect(source).toContain('sendDisposition.status');
    // The verdict must not be compared to a literal here as well; one mapping, one place.
    expect(source).not.toContain("audit.decision === 'BLOCK'");
    expect(source).not.toContain("audit.decision === 'PASS'");
  });
});

// ===========================================================================
describe('2. a check that did not run has no result', () => {
  it('NOT_RUN is not a pass', () => {
    expect(checkPassed('CLEAN')).toBe(true);
    expect(checkPassed('VIOLATED')).toBe(false);
    // The whole point. A boolean record forced this case to be written as one of the other
    // two, and it was always written as the safe one.
    expect(checkPassed('NOT_RUN')).toBe(false);
  });

  it('outcomeFromViolation takes the violation flag, not a clean flag', () => {
    expect(outcomeFromViolation(true)).toBe('VIOLATED');
    expect(outcomeFromViolation(false)).toBe('CLEAN');
  });
});

// ===========================================================================
describe('3. two opinions on one question', () => {
  const consulted = (source: string, value: 'ENDORSED' | 'REJECTED'): Opinion<'ENDORSED' | 'REJECTED'> => ({
    source,
    consulted: true,
    value,
  });
  const absent = (source: string): Opinion<'ENDORSED' | 'REJECTED'> => ({
    source,
    consulted: false,
    whyNot: 'not invoked',
  });

  it('no opinions is not agreement', () => {
    const r = reconcile('q', []);
    expect(r.agreed).toBe(false);
    if (r.agreed === false) expect(r.reason).toBe('NO_OPINIONS');
  });

  it('an unconsulted specialist is not an agreeing specialist', () => {
    const r = reconcile('q', [consulted('PRICING', 'ENDORSED'), absent('ROI')]);
    expect(r.agreed).toBe(false);
    if (r.agreed === false) {
      expect(r.reason).toBe('NOT_CONSULTED');
      expect(r.detail).toContain('ROI');
    }
  });

  it('unanimous consulted opinions agree, and carry every source', () => {
    const r = reconcile('q', [consulted('A', 'ENDORSED'), consulted('B', 'ENDORSED')]);
    expect(r.agreed).toBe(true);
    if (r.agreed === true) {
      expect(r.value).toBe('ENDORSED');
      expect(r.sources).toEqual(['A', 'B']);
    }
  });

  it('any divergence is a disagreement', () => {
    const r = reconcile('q', [consulted('A', 'ENDORSED'), consulted('B', 'REJECTED')]);
    expect(r.agreed).toBe(false);
    if (r.agreed === false) expect(r.reason).toBe('DISAGREEMENT');
  });

  /**
   * The four ways a disagreement gets silently resolved: majority, first-wins, last-wins, and
   * confidence-weighting. None is available — `reconcile` is never given anything to prefer
   * one opinion by. A three-to-one split is a disagreement, not a three.
   */
  it('a majority does not settle it, in either direction', () => {
    const threeToOne = reconcile('q', [
      consulted('A', 'ENDORSED'),
      consulted('B', 'ENDORSED'),
      consulted('C', 'ENDORSED'),
      consulted('D', 'REJECTED'),
    ]);
    expect(threeToOne.agreed).toBe(false);

    const oneToThree = reconcile('q', [
      consulted('A', 'REJECTED'),
      consulted('B', 'ENDORSED'),
      consulted('C', 'ENDORSED'),
      consulted('D', 'ENDORSED'),
    ]);
    expect(oneToThree.agreed).toBe(false);

    // And the dissent is named rather than absorbed, so an operator can see who differed.
    if (threeToOne.agreed === false) expect(threeToOne.detail).toContain('D');
    if (oneToThree.agreed === false) expect(oneToThree.detail).toContain('A');
  });

  it('one missing opinion outranks a disagreement among the rest', () => {
    // Both faults present. NOT_CONSULTED is reported, because "we never asked X" is the fact
    // an operator has to act on before the disagreement between the others means anything.
    const r = reconcile('q', [consulted('A', 'ENDORSED'), consulted('B', 'REJECTED'), absent('C')]);
    expect(r.agreed).toBe(false);
    if (r.agreed === false) expect(r.reason).toBe('NOT_CONSULTED');
  });

  it('every non-agreement becomes an ESCALATING finding, and agreement becomes none', () => {
    const agreed = reconcile('q', [consulted('A', 'ENDORSED')]);
    expect(findingFromReconciliation('x', agreed)).toBeNull();

    for (const r of [
      reconcile('q', []),
      reconcile('q', [absent('A')]),
      reconcile('q', [consulted('A', 'ENDORSED'), consulted('B', 'REJECTED')]),
    ]) {
      const f = findingFromReconciliation('specialist-consultation', r);
      expect(f).not.toBeNull();
      // Not caller-chosen. A caller free to pick the severity could pick ADVISORY, and an
      // advisory disagreement is a resolved disagreement under another name.
      if (f !== null) expect(f.severity).toBe('ESCALATING');
    }
  });

  it('a custom equality is used for comparison and still cannot break a tie', () => {
    type Amount = { pence: number };
    const opinions: Opinion<Amount>[] = [
      { source: 'A', consulted: true, value: { pence: 49900 } },
      { source: 'B', consulted: true, value: { pence: 49900 } },
    ];
    // Object.is would call these different objects; the comparator says they agree.
    expect(reconcile('q', opinions).agreed).toBe(false);
    expect(reconcile('q', opinions, (a, b) => a.pence === b.pence).agreed).toBe(true);
    // But a comparator cannot manufacture agreement between different answers.
    const differing: Opinion<Amount>[] = [
      { source: 'A', consulted: true, value: { pence: 49900 } },
      { source: 'B', consulted: true, value: { pence: 29900 } },
    ];
    expect(reconcile('q', differing, (a, b) => a.pence === b.pence).agreed).toBe(false);
  });
});

// ===========================================================================
describe('4. the auditor records what ran, not what would have been safe', () => {
  const identity = {
    contactId: 'ct_adj_1',
    resolutionMethod: 'EXACT_EMAIL' as const,
    email: 'adjudication-probe@clinic.example',
    name: 'Alice Smith',
    company: 'Clinic Example',
    domain: 'clinic.example',
    identityConfidence: 0.9,
  };

  const understanding = {
    primaryIntent: 'GENERAL_ENQUIRY' as any,
    secondaryIntents: [],
    explicitQuestions: [],
    hiddenQuestions: [],
    sentiment: 'NEUTRAL' as const,
    urgency: 'LOW' as const,
    commercialIntent: 'LOW' as const,
    technicalDepth: 'NONE' as const,
    buyingSignals: [],
    objections: [],
  };

  const nextBestAction = {
    action: 'ANSWER_AND_QUALIFY' as any,
    reason: 'r',
    meetingLinkAllowed: false,
    pricingAllowed: false,
    technicalAgentRequired: false,
    pricingAgentRequired: false,
    objectionAgentRequired: false,
    roiAgentRequired: false,
    humanReviewRequired: false,
    questionsToAnswer: [],
    questionsToAsk: [],
    missingInformation: [],
    confidence: 0.9,
  };

  const plan = (over: Partial<ReplyPlan> = {}): ReplyPlan =>
    ({
      contact: { name: identity.name, company: identity.company, email: identity.email },
      product: 'Abedin Voice AI',
      primaryIntent: understanding.primaryIntent,
      secondaryIntents: [],
      buyingStage: BuyingStage.DISCOVERY,
      purchaseReadiness: 40,
      meetingReadiness: 35,
      questionsToAnswer: [],
      knownRelevantFacts: [],
      objections: [],
      missingInformation: [],
      specialistsRequired: [],
      nextBestAction: 'ANSWER_AND_QUALIFY',
      sendBookingLink: false,
      sendOnboardingLink: false,
      reason: 'r',
      ...over,
    }) as ReplyPlan;

  // `isDuplicateSend` keeps a five-minute module-level fingerprint window, so every case needs
  // its own conversation id or the second identical body would BLOCK for the wrong reason.
  let n = 0;
  const audit = (draftBody: string, over: Partial<ReplyPlan> = {}, extra: any = {}) =>
    auditReplyAgainstPlan({
      draftBody,
      replyPlan: plan(over),
      identity,
      emailUnderstanding: understanding as any,
      nextBestAction: nextBestAction as any,
      conversationId: `conv-adj-${n++}`,
      now: '2026-09-07T00:00:00.000Z',
      ...extra,
    });

  /**
   * THE HEADLINE. Before this change the same draft returned
   * `zeroPhoneClean: true, semanticLinkClean: true, mergeTagsClean: true` — three literals,
   * written while `phoneRes.flagged` and `tagRes.flagged` were both `true` in scope.
   */
  it('a draft with a phone number and raw merge tags is not recorded as clean', async () => {
    const result = await audit('Hi {{firstName}}, call us on 020 7946 0018 to get started.');
    expect(result.safety.zeroPhone).toBe('VIOLATED');
    expect(result.safety.mergeTags).toBe('VIOLATED');
    // And the verdict reflects it. Those four sanitisers could not move the old score at all.
    expect(result.decision).toBe('REWRITE');
    expect(maySendAutonomously(result.decision)).toBe(false);
  });

  it('a rewrite is a finding, not an entry in the list of things that passed', async () => {
    const result = await audit('Hi {{firstName}}, ring 020 7946 0018.');
    const checks = result.findings.map((f) => f.check);
    expect(checks).toContain('zero-phone');
    expect(checks).toContain('merge-tags');
    // The old code pushed "Prohibited phone patterns neutralized (...)" into checksPassed.
    expect(result.checksPassed.join(' | ')).not.toMatch(/neutralized|normalized|corrected/i);
    for (const f of result.findings) {
      if (f.check === 'zero-phone' || f.check === 'merge-tags') {
        expect(f.severity).toBe('REWRITTEN');
      }
    }
  });

  it('a clean draft records each control as CLEAN and passes', async () => {
    const result = await audit('Thanks for getting in touch. Happy to answer that.');
    expect(result.safety.zeroPhone).toBe('CLEAN');
    expect(result.safety.mergeTags).toBe('CLEAN');
    expect(result.safety.semanticLink).toBe('CLEAN');
    expect(result.safety.trustedCta).toBe('CLEAN');
    expect(result.decision).toBe('PASS');
  });

  /**
   * The early returns were the worse half: they wrote `true` for checks still dozens of
   * lines below the return statement. The duplicate lock is one of the two that remain, and
   * it genuinely does stop before the content controls.
   */
  it('an early return records the checks below it as NOT_RUN, not as clean', async () => {
    const body = "Hi {{firstName}}, call 020 7946 0018.";
    const conversationId = `conv-dup-${n++}`;
    const once = (over: Partial<ReplyPlan> = {}) =>
      auditReplyAgainstPlan({
        draftBody: body,
        replyPlan: plan(over),
        identity,
        emailUnderstanding: understanding as any,
        nextBestAction: nextBestAction as any,
        conversationId,
        now: '2026-09-07T00:00:00.000Z',
      });

    // The first call primes the five-minute fingerprint; the second is the duplicate.
    const first = await once();
    expect(first.safety.duplicateLock).toBe('CLEAN');
    expect(first.safety.zeroPhone).toBe('VIOLATED');

    const second = await once();
    expect(second.decision).toBe('BLOCK');
    expect(second.safety.duplicateLock).toBe('VIOLATED');
    // The draft plainly contains a phone number and a merge tag. On this path nothing looked,
    // and the record says so instead of saying they were clean.
    expect(second.safety.zeroPhone).toBe('NOT_RUN');
    expect(second.safety.mergeTags).toBe('NOT_RUN');
    expect(second.safety.statedAmounts).toBe('NOT_RUN');
    expect(checkPassed(second.safety.zeroPhone)).toBe(false);
  });

  /**
   * S24 — the circuit breaker used to be an early return, and that quietly disabled every
   * content control in the function. `globalAutonomousSendEnabled` defaults to `false`
   * (P0.2, deliberately) and nothing in the product turns it on, so breaker-open is the
   * steady state of this deployment: under the early return, no draft was ever inspected by
   * anything, on any path, ever.
   */
  it('an open circuit breaker escalates without stopping the content checks', async () => {
    const wasEnabled = circuitBreaker.globalAutonomousSendEnabled;
    const wasReason = circuitBreaker.pausedReason;
    circuitBreaker.globalAutonomousSendEnabled = false;
    circuitBreaker.pausedReason = 'test';
    try {
      const result = await audit('Hi {{firstName}}, call 020 7946 0018.');
      expect(result.safety.circuitBreaker).toBe('VIOLATED');
      expect(result.decision).toBe('ESCALATE');
      // The point: the phone policy and the merge-tag normaliser still ran.
      expect(result.safety.zeroPhone).toBe('VIOLATED');
      expect(result.safety.mergeTags).toBe('VIOLATED');
      const checks = result.findings.map((f) => f.check);
      expect(checks).toContain('circuit-breaker');
      expect(checks).toContain('zero-phone');
    } finally {
      circuitBreaker.globalAutonomousSendEnabled = wasEnabled;
      circuitBreaker.pausedReason = wasReason;
    }
  });

  it('a closed circuit breaker is recorded as CLEAN rather than assumed', async () => {
    const wasEnabled = circuitBreaker.globalAutonomousSendEnabled;
    const wasReason = circuitBreaker.pausedReason;
    circuitBreaker.globalAutonomousSendEnabled = true;
    circuitBreaker.pausedReason = undefined;
    try {
      const result = await audit('Thanks for getting in touch.');
      expect(result.safety.circuitBreaker).toBe('CLEAN');
      expect(result.decision).toBe('PASS');
    } finally {
      circuitBreaker.globalAutonomousSendEnabled = wasEnabled;
      circuitBreaker.pausedReason = wasReason;
    }
  });
});

// ===========================================================================
describe('5. the specialists a plan requires', () => {
  const identity = {
    contactId: 'ct_adj_2',
    resolutionMethod: 'EXACT_EMAIL' as const,
    email: 'specialists-probe@clinic.example',
    name: 'Bob Jones',
    company: 'Clinic Example',
    domain: 'clinic.example',
    identityConfidence: 0.9,
  };
  const understanding = {
    primaryIntent: 'PRICING_QUESTION' as any,
    secondaryIntents: [],
    explicitQuestions: [],
    hiddenQuestions: [],
    sentiment: 'NEUTRAL' as const,
    urgency: 'LOW' as const,
    commercialIntent: 'MEDIUM' as const,
    technicalDepth: 'NONE' as const,
    buyingSignals: [],
    objections: [],
  };
  const nba = {
    action: 'PROVIDE_PRICING' as any,
    reason: 'r',
    meetingLinkAllowed: false,
    pricingAllowed: true,
    technicalAgentRequired: false,
    pricingAgentRequired: true,
    objectionAgentRequired: false,
    roiAgentRequired: true,
    humanReviewRequired: false,
    questionsToAnswer: [],
    questionsToAsk: [],
    missingInformation: [],
    confidence: 0.94,
  };

  let n = 0;
  const auditWith = (
    specialistsRequired: ReplyPlan['specialistsRequired'],
    specialistOpinions?: readonly Opinion<'ENDORSED' | 'REJECTED'>[]
  ) =>
    auditReplyAgainstPlan({
      draftBody: 'Happy to walk you through how it works.',
      replyPlan: {
        contact: { name: identity.name, company: identity.company, email: identity.email },
        product: 'Abedin Voice AI',
        primaryIntent: understanding.primaryIntent,
        secondaryIntents: [],
        buyingStage: BuyingStage.DISCOVERY,
        purchaseReadiness: 70,
        meetingReadiness: 35,
        questionsToAnswer: [],
        knownRelevantFacts: [],
        objections: [],
        missingInformation: [],
        specialistsRequired,
        nextBestAction: 'PROVIDE_PRICING',
        sendBookingLink: false,
        sendOnboardingLink: false,
        reason: 'r',
      } as ReplyPlan,
      identity,
      emailUnderstanding: understanding as any,
      nextBestAction: nba as any,
      conversationId: `conv-spec-${n++}`,
      now: '2026-09-07T00:00:00.000Z',
      specialistOpinions,
    });

  /**
   * `specialistsRequired` was written at three sites and read at NONE. A plan could declare
   * that a pricing specialist and an ROI specialist were required, and the reply went out with
   * neither consulted and nothing in the record saying so. This is its first reader.
   */
  it('a required specialist that was never consulted stops the draft', async () => {
    const result = await auditWith(['PRICING', 'ROI']);
    expect(result.decision).toBe('ESCALATE');
    expect(result.safety.specialistConsultation).toBe('VIOLATED');
    const f = result.findings.find((x) => x.check === 'specialist-consultation');
    expect(f).toBeDefined();
    if (f !== undefined) {
      expect(f.detail).toContain('NOT_CONSULTED');
      expect(f.detail).toContain('PRICING');
      expect(f.detail).toContain('ROI');
    }
  });

  it('a plan requiring no specialist is not escalated for the lack of one', async () => {
    const result = await auditWith([]);
    expect(result.safety.specialistConsultation).toBe('CLEAN');
    expect(result.findings.map((f) => f.check)).not.toContain('specialist-consultation');
  });

  it('specialists that all endorse the draft clear the check', async () => {
    const result = await auditWith(['PRICING'], [{ source: 'PRICING', consulted: true, value: 'ENDORSED' }]);
    expect(result.safety.specialistConsultation).toBe('CLEAN');
    expect(result.decision).toBe('PASS');
  });

  /**
   * Unanimous REJECTION is agreement, and `reconcile` reports it as such — correctly. A caller
   * that read only `agreed` would turn every specialist saying no into a pass.
   */
  it('specialists unanimously rejecting the draft is agreement, and still stops it', async () => {
    const result = await auditWith(['PRICING'], [{ source: 'PRICING', consulted: true, value: 'REJECTED' }]);
    expect(result.safety.specialistConsultation).toBe('VIOLATED');
    expect(result.decision).toBe('ESCALATE');
    const f = result.findings.find((x) => x.check === 'specialist-consultation');
    if (f !== undefined) expect(f.detail).toMatch(/rejected/i);
  });

  it('specialists that disagree are escalated rather than counted', async () => {
    const result = await auditWith(
      ['PRICING', 'ROI'],
      [
        { source: 'PRICING', consulted: true, value: 'ENDORSED' },
        { source: 'ROI', consulted: true, value: 'REJECTED' },
      ]
    );
    expect(result.decision).toBe('ESCALATE');
    const f = result.findings.find((x) => x.check === 'specialist-consultation');
    if (f !== undefined) expect(f.detail).toContain('DISAGREEMENT');
  });

  it('a partially supplied panel is NOT_CONSULTED, not a majority of one', async () => {
    const result = await auditWith(
      ['PRICING', 'ROI'],
      [{ source: 'PRICING', consulted: true, value: 'ENDORSED' }]
    );
    expect(result.decision).toBe('ESCALATE');
    const f = result.findings.find((x) => x.check === 'specialist-consultation');
    if (f !== undefined) {
      expect(f.detail).toContain('NOT_CONSULTED');
      expect(f.detail).toContain('ROI');
    }
  });
});

// ===========================================================================
describe('6. an amount cannot be cleared against a quote nobody read', () => {
  const identity = {
    contactId: 'ct_adj_3',
    resolutionMethod: 'EXACT_EMAIL' as const,
    email: 'quote-probe@clinic.example',
    name: 'Cara Patel',
    company: 'Clinic Example',
    domain: 'clinic.example',
    identityConfidence: 0.9,
  };
  const understanding = {
    primaryIntent: 'PRICING_QUESTION' as any,
    secondaryIntents: [],
    explicitQuestions: [],
    hiddenQuestions: [],
    sentiment: 'NEUTRAL' as const,
    urgency: 'LOW' as const,
    commercialIntent: 'MEDIUM' as const,
    technicalDepth: 'NONE' as const,
    buyingSignals: [],
    objections: [],
  };
  let n = 0;
  const run = (draftBody: string, quoteAvailability?: 'LOADED' | 'NOT_LOOKED_UP') =>
    auditReplyAgainstPlan({
      draftBody,
      replyPlan: {
        contact: { name: identity.name, company: identity.company, email: identity.email },
        product: 'Abedin Voice AI',
        primaryIntent: understanding.primaryIntent,
        secondaryIntents: [],
        buyingStage: BuyingStage.DISCOVERY,
        purchaseReadiness: 70,
        meetingReadiness: 35,
        questionsToAnswer: [],
        knownRelevantFacts: [],
        objections: [],
        missingInformation: [],
        specialistsRequired: [],
        nextBestAction: 'PROVIDE_PRICING',
        sendBookingLink: false,
        sendOnboardingLink: false,
        reason: 'r',
      } as ReplyPlan,
      identity,
      emailUnderstanding: understanding as any,
      nextBestAction: { confidence: 0.9 } as any,
      conversationId: `conv-quote-${n++}`,
      now: '2026-09-07T00:00:00.000Z',
      quoteAvailability,
    });

  /**
   * S14 — `quote: null` used to mean both "this customer has no quote" and "nobody looked".
   * `pricingContextFor(null, now)` treats it as the former and clears the draft against the
   * LIST price book, so the live pipeline — whose own context bundle records QUOTE as
   * unavailable — was authorising list pricing for customers who might hold a negotiated one.
   */
  it('a stated amount with no quote lookup is escalated even when the amount is in the price book', async () => {
    const result = await run('Our Growth plan is £499 per month.');
    expect(result.decision).toBe('ESCALATE');
    expect(result.safety.quoteAvailability).toBe('VIOLATED');
    const f = result.findings.find((x) => x.check === 'quote-availability');
    expect(f).toBeDefined();
    if (f !== undefined) expect(f.detail).toContain('£499');
  });

  it('the same draft passes once the caller says the quote was looked up', async () => {
    const result = await run('Our Growth plan is £499 per month.', 'LOADED');
    expect(result.safety.quoteAvailability).toBe('CLEAN');
    expect(result.findings.map((f) => f.check)).not.toContain('quote-availability');
  });

  it('a draft that states no amount is not held up by an unread quote', async () => {
    const result = await run('Happy to explain how the trial works.');
    expect(result.safety.quoteAvailability).toBe('NOT_RUN');
    expect(result.findings.map((f) => f.check)).not.toContain('quote-availability');
    expect(result.decision).toBe('PASS');
  });

  it('an amount that is in no price book is reported whatever the quote status', async () => {
    const result = await run('It is £1,234 per month.', 'LOADED');
    expect(result.safety.statedAmounts).toBe('VIOLATED');
    expect(result.decision).toBe('ESCALATE');
  });

  /**
   * A PASS is a statement about the controls that ran. The grounding engine names five claim
   * types it does not extract at all, and every result now carries them.
   */
  it('every result says what it did not examine', async () => {
    const clean = await run('Happy to explain how the trial works.');
    expect(clean.decision).toBe('PASS');
    expect(clean.notAssessed.length).toBeGreaterThan(0);
    expect(clean.notAssessed.join(' | ')).toMatch(/Capability claims/);
  });

  /**
   * Checks 10 and 11 were `auditPricingClaims` and `ClaimGroundingEngine.verifyClaims` — the
   * same function with the same three arguments. Measured over 1,350 drafts: 0 disagreements.
   * `checksPassed` collected two independent-sounding assurances from one computation, and the
   * second, "All claims grounded in approved knowledge", was false as written.
   */
  it('a clean draft is not told twice that its claims are fine', async () => {
    const result = await run('Happy to explain how the trial works.');
    const priceAssurances = result.checksPassed.filter((c) =>
      /amount stated|claims grounded/i.test(c)
    );
    expect(priceAssurances.length).toBe(1);
    expect(result.checksPassed.join(' | ')).not.toMatch(/All claims grounded in approved knowledge/);
  });
});

// ===========================================================================
describe('7. the code that used to be there is gone', () => {
  const strip = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\/:])\/\/[^\n]*/g, '$1');

  it('the auditor computes no score and thresholds nothing', () => {
    const source = strip('server/agents/independentAuditor.ts');
    expect(source).not.toMatch(/score\s*-=/);
    expect(source).not.toMatch(/score\s*>=\s*\d/);
    expect(source).not.toContain('let score');
    expect(source).toContain('adjudicate(findings)');
  });

  it('the live pipeline calls the auditor instead of a constant', () => {
    const source = strip('server/services/inboundPipeline.ts');
    expect(source).not.toContain('runIndependentAudit');
    expect(source).toContain('auditReplyAgainstPlan({');
    // The rewrites were computed and thrown away: `draft.body` was queued, not the sanitised
    // text the auditor produced.
    expect(source).toContain('htmlBody: audit.sanitizedBody');
    expect(source).not.toContain('htmlBody: draft.body');
    // Still recorded as removed, in the prose the strip above discards.
    expect(readFileSync('server/services/inboundPipeline.ts', 'utf8')).toContain(
      'runIndependentAudit()'
    );
  });

  it('the outbox row is created at the audited status, never at PENDING first', () => {
    const outbox = strip('server/services/outbox.service.ts');
    // Scoped to `queueMessage`, because `status: PENDING` is correct elsewhere in this file:
    // `approveForSending` moves HUMAN_REVIEW -> PENDING, transactionally and through the
    // shared transition map. What must not happen is a row being CREATED at PENDING and
    // flipped afterwards — it is claimable in between, and `claimPendingJobs` runs on a
    // continuous worker tick.
    const start = outbox.indexOf('async queueMessage(');
    expect(start).toBeGreaterThan(-1);
    const end = outbox.indexOf('async claimPendingJobs(', start);
    expect(end).toBeGreaterThan(start);
    const queueMessageSource = outbox.slice(start, end);
    expect(queueMessageSource).toContain('status: initialStatus');
    expect(queueMessageSource).not.toContain("status: 'PENDING'");
    // The unguarded status write is gone with it: every other transition on this collection
    // goes through assertTransition, and this one did not.
    expect(outbox).not.toContain('async holdForHumanReview');

    const pipeline = strip('server/services/inboundPipeline.ts');
    expect(pipeline).not.toContain('holdForHumanReview');
    // `queueMessage` returns null on an idempotency-key collision, and the old code skipped
    // the hold entirely in that case.
    expect(pipeline).toContain('queued === null');
  });

  /**
   * THE SECOND AUDITOR, and why it was deleted rather than fixed.
   *
   * `server/agents/qualityControlAgent.ts` was a whole parallel reply gate with its own
   * verdict vocabulary ("PASS" | "REWRITE" | "HUMAN_REVIEW" | "BLOCK"), its own 0-1 score,
   * and its own phone and link checks. It had ZERO callers.
   *
   * Its combination rule, verbatim, was:
   *
   *     decision: hasPhoneNumbers
   *       ? (data.decision === "BLOCK" ? "BLOCK" : "PASS")
   *       : (data.decision || fallbackData.decision),
   *
   * Read it in the direction that matters. When the deterministic phone check DID find a
   * phone number, the verdict became "PASS" — unless the model happened to say BLOCK. A model
   * answer of REWRITE or HUMAN_REVIEW was overwritten by the very fact that a violation had
   * been detected. Its own fallback (line 57) was stricter than its live path: it said
   * REWRITE for the same input.
   *
   * And the record it returned carried `phonePolicyFlagged: true` alongside `decision:
   * "PASS"`, so the two halves of the same object contradicted each other.
   *
   * That is the S24 failure in its purest form: two assessments of one question, resolved
   * silently, in favour of the less safe answer. Deleted rather than repaired because a
   * second gate with a different vocabulary is the thing that has to disagree with the first
   * one eventually, and nothing was calling it.
   */
  it('the second reply gate, which turned a detected phone number into a PASS, is gone', () => {
    let exists = true;
    try {
      readFileSync('server/agents/qualityControlAgent.ts', 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);

    // And nothing imports it, so this is a removal rather than an orphaning.
    for (const path of [
      'server/services/inboundPipeline.ts',
      'server/agents/independentAuditor.ts',
      'server/agents/salesEngineTestMatrix.ts',
      'server.ts',
    ]) {
      expect(readFileSync(path, 'utf8')).not.toContain('qualityControlAgent');
    }
  });
  it('no second, stale copy of the auditor result shape survives', () => {
    const models = readFileSync('shared/domain/models.ts', 'utf8');
    // It declared its own `auditorResult: { ..., score: number }` and its own six-boolean
    // safety record, neither of which the auditor produces any more. Nothing constructed it,
    // so the compiler could never have caught the drift.
    expect(models).not.toMatch(/^export interface ConversationDecisionLog/m);
    expect(models).not.toContain('zeroPhoneClean');
    expect(models).toContain('was DELETED here');
  });
});
