/**
 * S23 — abstention: the answer "I do not have one".
 *
 * WHAT WAS WRONG
 * --------------
 * `safeGenerateJSON` returns `T` whether the model answered or every candidate model failed:
 *
 *     return options.fallbackData;   // same type, same shape, indistinguishable
 *
 * P1.10 made that failure LOGGED and RECORDED, which was the observability half. The safety
 * half was never done: the caller still receives a well-formed object and has no way to branch
 * on whether a model produced it. There is no abstention member in any response schema, and
 * `INSUFFICIENT_INFORMATION` / `LOW_CONFIDENCE` / `CONFLICTING_EVIDENCE` / `ABSTAIN` appear
 * nowhere in executable code.
 *
 * The consequence in the live reply composer was worse than a fabricated field. Reaching the
 * fallback dropped through to a hand-written `switch` that composes a complete, send-ready
 * email — greeting, capability claims, list pricing quoted from `CANONICAL_KNOWLEDGE`, a
 * booking link and a signature — with no model involved, no flag, and no line in the run log
 * saying so. And because that same `switch` is what runs when `USE_GENAI_FOR_REPLIES` is not
 * `'true'` (it is `false` in this deployment), the canned template was not a rare fallback: it
 * was the composer.
 *
 * THE RULE
 * --------
 * An agent that cannot answer says so, and the caller must branch on that before using a
 * value. `ModelOutcome<T>` is a discriminated union rather than `T | null`, because `null`
 * collapses "no answer" into "an empty answer" — the same conflation that made a dead Gmail
 * credential look like a quiet inbox.
 *
 * Abstention is NOT an error. It is a legitimate, expected outcome that a well-behaved system
 * produces often: the evidence was insufficient, the sources disagreed, policy requires a
 * person. Modelling it as an exception would put it in a `catch` beside genuine faults, which
 * is where it would be swallowed.
 */

export const ABSTENTION_REASONS = [
  /** Every candidate model failed. No answer exists, and none is being invented. */
  'MODEL_UNAVAILABLE',
  /** A model answered, but with a value that cannot be acted on (empty, malformed, refusing). */
  'MODEL_RETURNED_NOTHING_USABLE',
  /** The context needed to answer was not available. */
  'INSUFFICIENT_INFORMATION',
  /** An answer exists but is not confident enough to act on autonomously. */
  'LOW_CONFIDENCE',
  /** Two sources that should agree do not. */
  'CONFLICTING_EVIDENCE',
  /** A person must decide this one, regardless of how good the answer is. */
  'POLICY_REQUIRES_HUMAN',
  /** The generation path is not enabled in this deployment. */
  'GENERATION_DISABLED',
] as const;

export type AbstentionReason = (typeof ABSTENTION_REASONS)[number];

export interface Abstention {
  readonly abstained: true;
  readonly reason: AbstentionReason;
  /** One line, written for the operator who finds this in a queue. */
  readonly detail: string;
}

export interface Answered<T> {
  readonly abstained: false;
  readonly value: T;
}

export type ModelOutcome<T> = Answered<T> | Abstention;

export function abstain(reason: AbstentionReason, detail: string): Abstention {
  return { abstained: true, reason, detail };
}

export function answered<T>(value: T): Answered<T> {
  return { abstained: false, value };
}

/**
 * Narrowing helper.
 *
 * Written as `outcome.abstained === false` rather than `!outcome.abstained` because this
 * project's `tsconfig.json` has no `strict`, and without it TypeScript does not narrow a
 * discriminated union through the negative arm of a truthiness test. Three separate defects on
 * this branch came from assuming it does.
 */
export function isAnswered<T>(outcome: ModelOutcome<T>): outcome is Answered<T> {
  return outcome.abstained === false;
}

export function isAbstention<T>(outcome: ModelOutcome<T>): outcome is Abstention {
  return outcome.abstained === true;
}

/**
 * May an autonomous action proceed on this outcome?
 *
 * An equality against the one permitting value, so a member added to `AbstentionReason` later
 * refuses by default instead of inheriting permission (§14).
 */
export function mayActAutonomouslyOn<T>(outcome: ModelOutcome<T>): boolean {
  return outcome.abstained === false;
}

/** A short, stable string for a log line or a status field. */
export function describeAbstention(a: Abstention): string {
  return `${a.reason}: ${a.detail}`;
}
