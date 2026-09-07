/**
 * S24 — DISAGREEMENT, AND WHAT MAY NOT RESOLVE IT.
 *
 * The addendum's requirement is that when two assessments of the same question differ, the
 * system must not pick one, average them, or let one cancel the other out. This module is the
 * vocabulary for that, and it is deliberately small: three ideas, none of which involve a
 * number.
 *
 * WHAT WAS THERE BEFORE
 * ---------------------
 * `independentAuditor.ts` combined its checks by subtraction from 100 and then thresholded:
 *
 *     score -= 15;   // draft used a CTA the plan withheld
 *     score -= 40;   // draft states a price this customer may not be quoted
 *     score -= 30;   // draft contains an ungrounded claim
 *     const finalDecision = score >= 90 ? "PASS" : score >= 70 ? "REWRITE" : "ESCALATE";
 *
 * Three consequences, all of them the thing S24 forbids:
 *
 *   1. Severity became tradeable. Findings of different kinds were summed into one scalar, so
 *      the verdict depended on how many other checks happened to fire rather than on what the
 *      worst one found.
 *   2. BLOCK was unreachable from the arithmetic — only two early returns could produce it —
 *      so no combination of content findings, however severe, could stop a draft.
 *   3. The penalties were chosen so that a lone pricing violation (-40 -> 60 -> ESCALATE) and
 *      a lone grounding violation (-30 -> 70 -> REWRITE) landed on different sides of a
 *      threshold. Measured over 1,350 drafts, those two checks NEVER fire independently: both
 *      call `auditPricingClaims` with identical arguments, so the -40 and -30 always apply
 *      together and the scores 60 and 70 are both unreachable. The arithmetic modelled a
 *      distinction that did not exist.
 *
 * `adjudicate` replaces all of it. It has no accumulator and no threshold, so there is
 * nothing for a future finding to be traded against.
 */

/**
 * Ordered least to most severe. The order IS the semantics — `adjudicate` reads this array,
 * so inserting a severity in the wrong position changes the outcome and nothing else needs to
 * know about it.
 */
export const SEVERITIES = ['ADVISORY', 'REWRITTEN', 'ESCALATING', 'BLOCKING'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ['PASS', 'REWRITE', 'ESCALATE', 'BLOCK'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * One thing a check found. `check` names the control, not the outcome, so a reader can tell
 * which control produced a finding without parsing prose.
 */
export interface Finding {
  readonly check: string;
  readonly severity: Severity;
  readonly detail: string;
}

const VERDICT_FOR: Readonly<Record<Severity, Verdict>> = Object.freeze({
  // An advisory finding is recorded and does not change the verdict. It is the only severity
  // for which that is true, and it exists so that "worth knowing" has somewhere to go other
  // than being upgraded into "stop".
  ADVISORY: 'PASS',
  REWRITTEN: 'REWRITE',
  ESCALATING: 'ESCALATE',
  BLOCKING: 'BLOCK',
});

/**
 * The verdict is the severity of the WORST finding. Not the sum, not the average, not the
 * count.
 *
 * Two properties follow, and both are tested:
 *
 *   - MONOTONE: adding a finding can never produce a less severe verdict. Under the old
 *     arithmetic that held only because every penalty happened to be negative; under any
 *     scheme with credits it would not have.
 *   - NON-COMPENSATORY: N findings of one severity never add up to a higher one, and a single
 *     high-severity finding is never diluted by any number of lower ones. A hundred REWRITTEN
 *     findings are a REWRITE; one BLOCKING finding among them is a BLOCK.
 */
export function adjudicate(findings: readonly Finding[]): Verdict {
  let worst = -1;
  for (const finding of findings) {
    const rank = SEVERITIES.indexOf(finding.severity);
    // A severity this module does not know about is not silently ignored. `indexOf` returns
    // -1 for it, and treating that as "less severe than everything" is how an unrecognised
    // finding would disappear, which is exactly the default-to-permission failure of S14.
    if (rank < 0) {
      throw new Error(
        '[adjudication] Unknown severity ' +
          JSON.stringify(finding.severity) +
          ' on check ' +
          JSON.stringify(finding.check) +
          '. A finding whose severity cannot be ranked must not be adjudicated; it would be ' +
          'treated as harmless.'
      );
    }
    if (rank > worst) worst = rank;
  }
  if (worst < 0) return 'PASS';
  return VERDICT_FOR[SEVERITIES[worst]];
}

/**
 * Whether a verdict permits sending without a human looking at the draft first.
 *
 * Only PASS does. Stated as its own function rather than inlined as `verdict === 'PASS'` at
 * each call site, because that is the comparison a newly added verdict would have to be
 * considered against, and having one place to change is the point.
 */
export function maySendAutonomously(verdict: Verdict): boolean {
  return verdict === 'PASS';
}

/**
 * What a verdict means for the outbox: whether the draft is stored at all, and at what status.
 *
 * P0.11 — this mapping was two inline expressions in `processNewEmail`:
 *
 *     if (audit.decision === 'BLOCK') { return { disposition: 'BLOCKED', ... }; }
 *     const outboxStatus = maySendAutonomously(audit.decision) ? 'PENDING' : 'HUMAN_REVIEW';
 *
 * Correct, and untestable. `processNewEmail` needs Firestore, a Gmail client and a resolved
 * tenant, so nothing exercised it: mutating either expression left the whole gate green.
 * Pulled out here, the mapping from verdict to outbox action is a total function over four
 * inputs and can be checked exhaustively.
 */
export type SendDisposition =
  | { readonly queue: false; readonly reason: 'BLOCKED' }
  | { readonly queue: true; readonly status: 'PENDING' | 'HUMAN_REVIEW' };

export function dispositionFor(verdict: Verdict): SendDisposition {
  // BLOCK is the only verdict that means "do not store this draft at all". The other three
  // all produce a durable row, because a draft an operator cannot see is a draft nobody can
  // act on — the difference between them is whether a worker may pick it up.
  if (verdict === 'BLOCK') return { queue: false, reason: 'BLOCKED' };
  return { queue: true, status: maySendAutonomously(verdict) ? 'PENDING' : 'HUMAN_REVIEW' };
}

// ---------------------------------------------------------------------------
// What a check RECORD may say
// ---------------------------------------------------------------------------

/**
 * S2 / S50 — a check that did not run has no result.
 *
 * `AuditResult.deterministicSafetyResult` used to be six booleans, and on all four of the
 * auditor's return paths at least three of them were the literal `true` for checks that had
 * not executed at that point in the function. On the success path all six were literals while
 * the real `phoneRes.flagged` / `linkRes.flagged` / `tagRes.flagged` values sat in scope
 * unused, so a draft containing a phone number, a swapped Meet URL and raw merge tags
 * recorded `zeroPhoneClean: true, semanticLinkClean: true, mergeTagsClean: true`.
 *
 * A boolean cannot express "not run", so it gets written as the safe-looking value. This type
 * makes the distinction unavoidable: there is no way to write the record without saying which
 * of the three it is.
 */
export const CHECK_OUTCOMES = ['CLEAN', 'VIOLATED', 'NOT_RUN'] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** CLEAN is the only outcome that means the control looked and found nothing. */
export function checkPassed(outcome: CheckOutcome): boolean {
  return outcome === 'CLEAN';
}

/**
 * Turn a boolean a check actually computed into a record of what it found.
 *
 * Takes the VIOLATION flag rather than a "clean" flag on purpose: every one of the underlying
 * validators reports `flagged` or `modified`, and a helper that inverted the sense here would
 * be one negation away from recording every violation as clean.
 */
export function outcomeFromViolation(violated: boolean): CheckOutcome {
  return violated === true ? 'VIOLATED' : 'CLEAN';
}

// ---------------------------------------------------------------------------
// Two opinions on one question
// ---------------------------------------------------------------------------

/**
 * An opinion that was asked for and may or may not have been given.
 *
 * `consulted: false` carries no value of `T` and cannot be compared with one. That is the
 * whole design: a specialist that was never invoked must not be representable as one that
 * agreed.
 */
export type Opinion<T> =
  | { readonly source: string; readonly consulted: true; readonly value: T }
  | { readonly source: string; readonly consulted: false; readonly whyNot: string };

export type Reconciliation<T> =
  | { readonly agreed: true; readonly value: T; readonly sources: readonly string[] }
  | {
      readonly agreed: false;
      readonly reason: 'DISAGREEMENT' | 'NOT_CONSULTED' | 'NO_OPINIONS';
      readonly detail: string;
    };

/**
 * Combine opinions about one question, or report that they cannot be combined.
 *
 * There is no tie-break, no majority, no ordering by confidence and no first-answer-wins.
 * Those are the four ways a disagreement gets silently resolved, and none of them is
 * available here — the function has no way to prefer one opinion over another because it is
 * never given anything to prefer them by.
 *
 * The three non-agreements are distinguished because they call for different responses:
 * NO_OPINIONS means nobody was asked, NOT_CONSULTED means someone was asked and did not
 * answer, DISAGREEMENT means they answered differently.
 */
export function reconcile<T>(
  question: string,
  opinions: readonly Opinion<T>[],
  sameAnswer: (a: T, b: T) => boolean = (a, b) => Object.is(a, b)
): Reconciliation<T> {
  if (opinions.length === 0) {
    return {
      agreed: false,
      reason: 'NO_OPINIONS',
      detail: 'No opinion was obtained on: ' + question + '. An unasked question has no answer.',
    };
  }

  const missing: { source: string; whyNot: string }[] = [];
  const given: { source: string; value: T }[] = [];
  for (const opinion of opinions) {
    // Explicit `=== true` / `=== false` rather than truthiness: this repository compiles
    // without `strict`, where TypeScript does not narrow a discriminated union through a
    // negated truthiness test, and `opinion.value` below depends on the narrowing holding.
    if (opinion.consulted === false) missing.push({ source: opinion.source, whyNot: opinion.whyNot });
    else given.push({ source: opinion.source, value: opinion.value });
  }

  if (missing.length > 0) {
    return {
      agreed: false,
      reason: 'NOT_CONSULTED',
      detail:
        question +
        ' — required opinion(s) not obtained: ' +
        missing.map((m) => m.source + ' (' + m.whyNot + ')').join('; ') +
        '.',
    };
  }

  const first = given[0];
  const dissenting = given.filter((o) => sameAnswer(first.value, o.value) === false);
  if (dissenting.length > 0) {
    return {
      agreed: false,
      reason: 'DISAGREEMENT',
      detail:
        question +
        ' — ' +
        first.source +
        ' says ' +
        JSON.stringify(first.value) +
        '; ' +
        dissenting.map((o) => o.source + ' says ' + JSON.stringify(o.value)).join('; ') +
        '. Not resolved: a disagreement is an escalation, not an input to a vote.',
    };
  }

  return { agreed: true, value: first.value, sources: given.map((o) => o.source) };
}

/**
 * A non-agreement, as a finding.
 *
 * Every reason maps to ESCALATING rather than to a severity the caller chooses. A caller that
 * could pick the severity could pick ADVISORY, and an advisory disagreement is a resolved
 * disagreement wearing a different word.
 */
export function findingFromReconciliation<T>(
  check: string,
  reconciliation: Reconciliation<T>
): Finding | null {
  if (reconciliation.agreed === true) return null;
  return {
    check,
    severity: 'ESCALATING',
    detail: '[' + reconciliation.reason + '] ' + reconciliation.detail,
  };
}
