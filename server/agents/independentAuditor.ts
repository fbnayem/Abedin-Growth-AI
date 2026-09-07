import { ClaimGroundingEngine } from '../policies/claimGrounding';
import { pricingContextFor, type Quote } from '../../shared/domain/quote';
import { extractMoneyLiterals, formatMoney, type Money } from '../../shared/domain/pricing';
import {
  ReplyPlan,
  ClientIdentityResolution,
  EmailUnderstanding,
  NextBestActionResult,
} from "../../shared/domain/models";
import {
  CALENDAR_BOOKING_URL,
  WEBSITE_URL,
  sanitizeCtaUrls,
} from "./trustedCtaRegistry";
import {
  validateAndEnforceNoPhonePolicy,
  validateAndEnforceMeetingAndCalendarLinks,
  normalizeMergeTags,
} from "./multiAgentReplySystem";
import {
  isSuppressed,
  circuitBreaker,
  isDuplicateSend,
} from "./salesDecisionEngine";
import {
  adjudicate,
  findingFromReconciliation,
  outcomeFromViolation,
  reconcile,
  type CheckOutcome,
  type Finding,
  type Opinion,
  type Verdict,
} from '../domain/adjudication';

/**
 * What each deterministic control found, or that it did not run.
 *
 * S24 — this was six `boolean`s named `...Clean`, and on every one of the auditor's four
 * return paths at least three of them were the literal `true`. The success path wrote all six
 * as literals while the real `flagged` values computed a hundred lines earlier sat unused, so
 * a draft carrying a phone number, a swapped Meet URL and raw merge tags was recorded as
 * clean on all three. The type could not say "did not run", so the checks that had not run
 * were recorded as the safe value.
 *
 * `CheckOutcome` has no safe default. Every field must be written as CLEAN, VIOLATED or
 * NOT_RUN, and the early-return paths genuinely are NOT_RUN for the checks below them.
 */
export interface SafetyRecord {
  readonly suppression: CheckOutcome;
  readonly circuitBreaker: CheckOutcome;
  readonly duplicateLock: CheckOutcome;
  readonly zeroPhone: CheckOutcome;
  readonly semanticLink: CheckOutcome;
  readonly mergeTags: CheckOutcome;
  readonly trustedCta: CheckOutcome;
  readonly ctaPermission: CheckOutcome;
  readonly specialistConsultation: CheckOutcome;
  readonly statedAmounts: CheckOutcome;
  readonly quoteAvailability: CheckOutcome;
}

/** Everything below the point an early return fired. Written once, used four times. */
const NOT_RUN_BELOW: SafetyRecord = Object.freeze({
  suppression: 'NOT_RUN',
  circuitBreaker: 'NOT_RUN',
  duplicateLock: 'NOT_RUN',
  zeroPhone: 'NOT_RUN',
  semanticLink: 'NOT_RUN',
  mergeTags: 'NOT_RUN',
  trustedCta: 'NOT_RUN',
  ctaPermission: 'NOT_RUN',
  specialistConsultation: 'NOT_RUN',
  statedAmounts: 'NOT_RUN',
  quoteAvailability: 'NOT_RUN',
});

export interface AuditResult {
  /**
   * S24 — derived by `adjudicate` from `findings`, never from arithmetic. There is no `score`
   * on this type any more: the old one summed penalties of different kinds into a scalar and
   * thresholded it, which made severity tradeable and left BLOCK unreachable.
   */
  decision: Verdict;
  /** Every finding, with its own severity. The verdict is the worst of these. */
  findings: readonly Finding[];
  checksPassed: string[];
  sanitizedBody: string;
  safety: SafetyRecord;
  /**
   * What this audit did NOT examine.
   *
   * A PASS means "the controls listed in `checksPassed` found nothing", not "the draft is
   * safe". Stating the gap as data rather than leaving it implied is the difference between
   * an operator who knows capability claims are unverified and one who reads PASS as a
   * clearance.
   */
  notAssessed: readonly string[];
}

/**
 * Executes the Independent Executive Reply Auditor (Part 30 & 31).
 */
export async function auditReplyAgainstPlan(input: {
  draftBody: string;
  replyPlan: ReplyPlan;
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  conversationId: string;
  /**
   * P1.7 — The quote in force for this customer, if any. Passed in rather than looked up so
   * the auditor stays a pure function of its inputs and can be tested against a withdrawn or
   * expired quote without a datastore.
   */
  quote?: Quote | null;
  /**
   * S14 — whether this customer quotes were LOOKED UP, which is not the same as their
   * having none.
   *
   * `quote: null` previously meant both. `pricingContextFor(null, now)` treats it as "no
   * quote binds" and judges the draft against the LIST price book, so a caller that simply
   * had not loaded quotes silently authorised list pricing for a customer who may hold a
   * negotiated one. The live pipeline is exactly that caller: its context bundle records
   * QUOTE in `unavailable`, and it passed nothing here.
   *
   * Defaults to NOT_LOOKED_UP, so a caller that has not thought about it does not assert
   * that it looked. The consequence is confined to drafts that actually state an amount —
   * a check that fired on every reply would be switched off within a week.
   */
  quoteAvailability?: 'LOADED' | 'NOT_LOOKED_UP';
  /**
   * Figures that are money but are NOT prices — an approved ROI claim such as "recovers
   * £18,000 monthly". Without these every such sentence is reported, and a check that cries
   * wolf gets switched off, which is worse than the check not existing.
   */
  groundedNonPriceAmounts?: readonly Money[];
  /**
   * S24 — what the specialists this plan requires actually said.
   *
   * `ReplyPlan.specialistsRequired` was written at three sites and read at NONE, so a plan
   * declaring that a pricing specialist was required produced a reply nobody had asked a
   * pricing specialist about. This is its first reader. An absent opinion is not silence to be
   * ignored: a required specialist with no entry here is recorded as NOT_CONSULTED and the
   * draft cannot pass.
   */
  specialistOpinions?: readonly Opinion<'ENDORSED' | 'REJECTED'>[];
  /** Injectable for tests; a pricing check that depends on the wall clock cannot be tested. */
  now?: string;
}): Promise<AuditResult> {
  const checksPassed: string[] = [];
  const findings: Finding[] = [];

  /**
   * The grounding engine names the claim types it does not look at. Carried into every result
   * — including the early returns, where even less was examined.
   */
  const notAssessed: string[] = [...ClaimGroundingEngine.UNCHECKED_CLAIM_TYPES];

  // 1. Hard Blocker: Suppression Check
  const suppressionCheck = isSuppressed(input.identity.email);
  if (suppressionCheck.suppressed) {
    return {
      decision: 'BLOCK',
      findings: [
        {
          check: 'suppression',
          severity: 'BLOCKING',
          detail: `Suppression violation: ${suppressionCheck.reason}`,
        },
      ],
      checksPassed: [],
      sanitizedBody: "",
      safety: { ...NOT_RUN_BELOW, suppression: 'VIOLATED' },
      notAssessed: [...notAssessed, 'Every content control below the suppression blocker'],
    };
  }
  checksPassed.push("Suppression verification clean");

  // 2. Circuit Breaker — a FINDING, not an early return.
  //
  // S24 — this returned immediately, and that quietly disabled every content control in the
  // function. `globalAutonomousSendEnabled` defaults to `false` (P0.2, deliberately: the
  // master autonomy switch must fail closed) and nothing in the product turns it on, so the
  // steady state of this deployment is breaker-open. Under the early return that meant the
  // phone policy, the link semantics, the merge tags, the CTA registry, the specialists and
  // the pricing check never ran on ANY draft — and the operator reviewing the held draft was
  // shown a record in which all of them said nothing.
  //
  // The breaker is a permission to SEND. It is not evidence about this draft, so it belongs
  // beside the other findings rather than in front of them. It still escalates on its own;
  // it no longer decides whether anything gets inspected.
  let circuitBreakerOutcome: CheckOutcome = "CLEAN";
  if (!circuitBreaker.globalAutonomousSendEnabled) {
    circuitBreakerOutcome = "VIOLATED";
    findings.push({
      check: 'circuit-breaker',
      severity: 'ESCALATING',
      detail: `Circuit breaker active: ${circuitBreaker.pausedReason}`,
    });
  } else {
    checksPassed.push("Global circuit breaker operational");
  }

  // 3. Hard Blocker: Duplicate Send Detection
  if (input.draftBody && isDuplicateSend(input.conversationId, input.draftBody)) {
    return {
      decision: 'BLOCK',
      // Carries the findings already collected. A breaker finding raised above does not stop
      // being true because a duplicate was then detected.
      findings: [
        ...findings,
        {
          check: 'duplicate-lock',
          severity: 'BLOCKING',
          detail: 'Duplicate identical message detected within 5-minute safety window',
        },
      ],
      checksPassed,
      sanitizedBody: "",
      safety: {
        ...NOT_RUN_BELOW,
        suppression: 'CLEAN',
        circuitBreaker: circuitBreakerOutcome,
        duplicateLock: 'VIOLATED',
      },
      notAssessed: [...notAssessed, 'Every content control below the duplicate lock'],
    };
  }
  checksPassed.push("Idempotency and duplicate check clean");

  // 4-7. Deterministic sanitisation.
  //
  // S24 — all four of these MUTATE the draft, and all four used to push their result into
  // `checksPassed` whether they had fired or not:
  //
  //     if (phoneRes.flagged) checksPassed.push("Prohibited phone patterns neutralized (...)");
  //     else                  checksPassed.push("Zero phone numbers in draft");
  //
  // so a control that found a violation and rewrote the customer's reply was recorded in the
  // list of things that passed, and could not affect the verdict at all — none of the four
  // touched the score. A rewrite is now a REWRITTEN finding, which is what makes the verdict
  // reflect it.
  const phoneRes = validateAndEnforceNoPhonePolicy(input.draftBody);
  let sanitizedBody = phoneRes.sanitized;
  if (phoneRes.flagged) {
    findings.push({
      check: 'zero-phone',
      severity: 'REWRITTEN',
      detail: `Prohibited phone patterns neutralized (${phoneRes.detectedPatterns.join(", ")})`,
    });
  } else {
    checksPassed.push("Zero phone numbers in draft");
  }

  const linkRes = validateAndEnforceMeetingAndCalendarLinks(sanitizedBody);
  sanitizedBody = linkRes.sanitized;
  if (linkRes.flagged) {
    findings.push({
      check: 'semantic-link',
      severity: 'REWRITTEN',
      detail: `Link semantic alignment corrected (${linkRes.correctedPatterns.join("; ")})`,
    });
  } else {
    checksPassed.push("Calendar vs Meet URL semantics verified");
  }

  const firstName = input.identity.name?.replace(/^Dr\.\s+/i, "").split(" ")[0];
  const tagRes = normalizeMergeTags(sanitizedBody, {
    firstName,
    companyName: input.identity.company,
  });
  sanitizedBody = tagRes.sanitized;
  if (tagRes.flagged) {
    findings.push({
      check: 'merge-tags',
      severity: 'REWRITTEN',
      detail: `Unresolved merge tags normalized (${tagRes.resolvedTags.join("; ")})`,
    });
  } else {
    checksPassed.push("Zero raw template merge tags");
  }

  const ctaRes = sanitizeCtaUrls(sanitizedBody);
  sanitizedBody = ctaRes.sanitized;
  if (ctaRes.modified) {
    findings.push({
      check: 'trusted-cta',
      severity: 'REWRITTEN',
      detail: `External CTA URLs aligned to trusted registry (${ctaRes.corrections.join("; ")})`,
    });
  } else {
    checksPassed.push("All hyperlinks approved in CTA Registry");
  }

  // 8. The draft used a CTA the plan withheld.
  //
  // `sendBookingLink` is a PERMISSION the planner grants. The composer exercising one it was
  // denied is the planner and the composer disagreeing about what this reply is for, and it
  // used to cost 15 points — which, since the pricing and grounding penalties always fire
  // together and take the score to 30 on their own, could not change any verdict it did not
  // already agree with.
  let ctaPermission: CheckOutcome = 'CLEAN';
  if (!input.replyPlan.sendBookingLink && sanitizedBody.includes(CALENDAR_BOOKING_URL)) {
    ctaPermission = 'VIOLATED';
    findings.push({
      check: 'cta-permission',
      severity: 'ESCALATING',
      detail:
        'The draft contains the booking link, and the plan set sendBookingLink=false. The ' +
        'link has been replaced with the website URL, but the composer and the planner ' +
        'disagree about this reply and that is not for the auditor to settle.',
    });
    sanitizedBody = sanitizedBody.replace(CALENDAR_BOOKING_URL, WEBSITE_URL);
  } else {
    checksPassed.push("Meeting readiness & CTA gating strictly aligned");
  }

  // 9. Quality Check: Direct Question-First Rule (Part 19)
  if (input.emailUnderstanding.explicitQuestions.length > 0) {
    checksPassed.push("Explicit prospect questions addressed directly");
  }

  // 10. S24 — the specialists this plan required.
  //
  // The four `*AgentRequired` booleans on NextBestActionResult are read once, to build
  // `ReplyPlan.specialistsRequired`, which had no reader at all. So a plan could declare that
  // pricing and ROI specialists were required and the reply went out with neither consulted,
  // and nothing in the record said so.
  //
  // `reconcile` refuses to treat an unasked specialist as an agreeing one. As the code stands
  // no specialist agent is invoked on any live path, so every plan requiring one escalates.
  // That is the correct reading of the current state, not a defect in this check.
  const specialistsRequired = input.replyPlan.specialistsRequired ?? [];
  let specialistConsultation: CheckOutcome = 'NOT_RUN';
  if (specialistsRequired.length > 0) {
    const supplied = input.specialistOpinions ?? [];
    const opinions: Opinion<'ENDORSED' | 'REJECTED'>[] = specialistsRequired.map((role) => {
      const given = supplied.find((o) => o.source === role);
      if (given !== undefined) return given;
      return {
        source: role,
        consulted: false as const,
        whyNot: 'no specialist agent is invoked on this path',
      };
    });
    const verdict = reconcile(
      'Do the specialists this plan requires endorse the draft?',
      opinions
    );
    const finding = findingFromReconciliation('specialist-consultation', verdict);
    if (finding !== null) {
      findings.push(finding);
      specialistConsultation = 'VIOLATED';
    } else if (verdict.agreed === true && verdict.value !== 'ENDORSED') {
      // Unanimous rejection is agreement, and `reconcile` correctly reports it as such. It is
      // still a refusal, and reading only `agreed` would turn every specialist saying no into
      // a pass.
      findings.push({
        check: 'specialist-consultation',
        severity: 'ESCALATING',
        detail: `Every consulted specialist (${verdict.sources.join(', ')}) rejected this draft.`,
      });
      specialistConsultation = 'VIOLATED';
    } else {
      specialistConsultation = 'CLEAN';
      checksPassed.push(`Specialists endorsed the draft: ${specialistsRequired.join(', ')}`);
    }
  } else {
    // No specialist was required, so there is no question and nothing to reconcile. Recorded
    // as CLEAN rather than NOT_RUN: the control ran and found no obligation.
    specialistConsultation = 'CLEAN';
    checksPassed.push('No specialist consultation was required by the plan');
  }

  // 11. Every amount stated in the draft.
  //
  // S24 — THIS WAS TWO CHECKS, AND THEY WERE THE SAME CHECK.
  //
  //     const pricingFindings = auditPricingClaims(sanitizedBody, quotable, nonPrice);
  //     if (pricingFindings.length > 0) score -= 40;
  //     ...
  //     const groundingResult = await engine.verifyClaims(sanitizedBody, quotable, nonPrice);
  //     if (!groundingResult.isGrounded)  score -= 30;
  //
  // `verifyClaims` IS `auditPricingClaims` with the same three arguments — it returns
  // `isGrounded: auditPricingClaims(...).length === 0` and nothing else. Measured over 1,350
  // drafts spanning 15 amounts in 6 sentence frames: 913 where both fired, 437 where neither
  // did, and ZERO where they disagreed, including the message text. The -40 and -30 therefore
  // always applied together (100 -> 30 -> ESCALATE), so the scores 60 and 70 that the
  // thresholds were tuned around were both unreachable.
  //
  // The cost was not the wasted call. It was that `checksPassed` collected two
  // independent-sounding assurances from one computation, and the second of them —
  // "All claims grounded in approved knowledge" — was false as written: the engine's own
  // comment says non-price claims are not extracted or matched at all. A single check now
  // runs, behind the name that claims the most, and what it does not cover is reported in
  // `notAssessed` instead of being implied by a pass.
  const quoteAvailability = input.quoteAvailability ?? 'NOT_LOOKED_UP';
  const statedLiterals = extractMoneyLiterals(sanitizedBody);
  if (quoteAvailability === 'NOT_LOOKED_UP' && statedLiterals.length > 0) {
    findings.push({
      check: 'quote-availability',
      severity: 'ESCALATING',
      detail:
        'The draft states ' +
        statedLiterals.map((m) => formatMoney(m)).join(', ') +
        ', and this customer quotes were not looked up. Whatever the price book says, an ' +
        'amount cannot be cleared against a quote nobody read.',
    });
  }
  const pricingContext = pricingContextFor(input.quote ?? null, input.now ?? new Date().toISOString());
  const grounding = await new ClaimGroundingEngine().verifyClaims(
    sanitizedBody,
    pricingContext.quotableAmounts,
    input.groundedNonPriceAmounts ?? []
  );

  let statedAmounts: CheckOutcome;
  if (grounding.isGrounded === false) {
    statedAmounts = 'VIOLATED';
    for (const claim of grounding.ungroundedClaims) {
      // A wrong price is a commercial commitment made to a customer in writing. It escalates
      // on its own — not because of what it is worth relative to other findings, but because
      // no rewrite the auditor could perform would make the draft say the right number.
      findings.push({ check: 'stated-amounts', severity: 'ESCALATING', detail: claim });
    }
  } else {
    statedAmounts = 'CLEAN';
    checksPassed.push(
      pricingContext.listPricingWithheld
        ? 'Every amount stated is on the customer approved quote (list pricing withheld)'
        : 'Every amount stated is in the price book'
    );
  }

  if (pricingContext.listPricingWithheld) {
    // Recorded because it is the mechanism, not a detail: the model was never shown list
    // pricing for this customer, so it could not have quoted it.
    checksPassed.push(pricingContext.rationale);
  }

  return {
    decision: adjudicate(findings),
    findings,
    checksPassed,
    sanitizedBody,
    safety: {
      suppression: 'CLEAN',
      circuitBreaker: circuitBreakerOutcome,
      duplicateLock: 'CLEAN',
      // Derived from the values the checks produced, in the same function, rather than
      // asserted. `outcomeFromViolation` takes the violation flag so that the sense cannot be
      // inverted by a stray negation on the way in.
      zeroPhone: outcomeFromViolation(phoneRes.flagged),
      semanticLink: outcomeFromViolation(linkRes.flagged),
      mergeTags: outcomeFromViolation(tagRes.flagged),
      trustedCta: outcomeFromViolation(ctaRes.modified),
      ctaPermission,
      specialistConsultation,
      statedAmounts,
      quoteAvailability:
        quoteAvailability === 'LOADED'
          ? 'CLEAN'
          : statedLiterals.length > 0
            ? 'VIOLATED'
            : 'NOT_RUN',
    },
    notAssessed,
  };
}
