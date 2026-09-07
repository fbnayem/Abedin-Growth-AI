/**
 * S45 — the service level objectives, as the only place a latency budget is written down.
 *
 * WHAT WAS THERE
 * --------------
 * The string "SLO" appeared once in the repository, inside a `console.warn`. The only numeric
 * target was a bare `2000`, applied uniformly to three unrelated operations:
 *
 *     if (durationMs > 2000) console.warn(`[SLO ALERT] ${operation} exceeded ...`)
 *
 * One constant for inbound processing, an AI decision and an email send. No per-operation
 * target, no percentile, no window, no error budget — and it fired on a SINGLE SAMPLE, which is
 * the wrong shape for a latency objective in both directions: one slow request pages someone,
 * and a system that is slow half the time never breaches if each sample is judged alone.
 *
 * WHY THE TARGETS LIVE IN CODE AND IN A DOCUMENT
 * ----------------------------------------------
 * `docs/production/slo.md` is the readable version and this is the executable one. They are
 * checked against each other by `server/tests/slo.invariant.test.ts`, so a target changed in one
 * and not the other fails the build. A document nothing enforces drifts; a constant nobody can
 * read gets copied.
 *
 * WHY THERE IS NO DEFAULT
 * -----------------------
 * `sloFor` throws on an operation it does not know. The alternative — a fallback budget — means
 * a new operation is silently measured against a number chosen for something else, which is what
 * the shared 2000 already was.
 */

export const SLO_OPERATIONS = [
  'INBOUND_PROCESSING',
  'DRAFT_GENERATION',
  'APPROVED_SEND',
  'QUEUE_DELAY',
  'RECONCILIATION',
] as const;

export type SloOperation = (typeof SLO_OPERATIONS)[number];

export interface Slo {
  /** Which percentile the budget applies to. A budget without one is a budget on the fastest request. */
  readonly percentile: 50 | 95 | 99;
  /** The budget, in milliseconds. */
  readonly budgetMs: number;
  /** How long a window the percentile is computed over, in milliseconds. */
  readonly windowMs: number;
  /** Why this number and not another. An unexplained target cannot be argued with or revised. */
  readonly rationale: string;
}

const HOUR = 60 * 60 * 1000;

/**
 * The objectives. Each is a decision someone can disagree with, which is the point of writing
 * it down.
 */
export const SLOS: Readonly<Record<SloOperation, Slo>> = Object.freeze({
  INBOUND_PROCESSING: {
    percentile: 95,
    budgetMs: 60_000,
    windowMs: HOUR,
    rationale:
      'from webhook receipt to the message being durably stored and classified. A minute is ' +
      'slow for a machine and invisible to a customer, who is not waiting on this step.',
  },
  DRAFT_GENERATION: {
    percentile: 95,
    budgetMs: 30_000,
    windowMs: HOUR,
    rationale:
      'the model calls plus the audit. Above this the reply is late enough that a human would ' +
      'have answered first, which removes the reason for the system to exist.',
  },
  APPROVED_SEND: {
    percentile: 95,
    budgetMs: 120_000,
    windowMs: HOUR,
    rationale:
      'from an operator approving a draft to the provider accepting it. Two minutes covers a ' +
      'claim, a dispatch and one retry; beyond that the operator has moved on and will not ' +
      'connect a later failure to what they did.',
  },
  QUEUE_DELAY: {
    percentile: 99,
    budgetMs: 5 * 60_000,
    windowMs: HOUR,
    rationale:
      'how long a PENDING job waits before a worker claims it. p99 rather than p95 because the ' +
      'failure this detects — a dead worker — affects every job, not a tail.',
  },
  RECONCILIATION: {
    percentile: 95,
    budgetMs: 15 * 60_000,
    windowMs: 6 * HOUR,
    rationale:
      'how long an AMBIGUOUS send stays unresolved. Not yet measured: no reconciler exists ' +
      '(S32). The budget is recorded so the objective is not invented later to fit whatever ' +
      'the reconciler turns out to do.',
  },
});

export function sloFor(operation: SloOperation): Slo {
  const slo = SLOS[operation];
  if (!slo) {
    throw new Error(
      `[slo] no objective for ${JSON.stringify(operation)}. Add one to SLOS and to ` +
        'docs/production/slo.md rather than measuring it against a budget chosen for ' +
        'something else — a shared constant applied to unrelated operations is what this replaces.'
    );
  }
  return slo;
}

/**
 * The value at a percentile, by nearest-rank on the sorted samples.
 *
 * Nearest-rank rather than interpolation because the answer is always an observed measurement:
 * "p95 is 812ms" then names a request that actually took 812ms, and an operator can go and look
 * at it. Interpolation produces a number no request ever recorded.
 *
 * @throws on an empty sample set. There is no percentile of nothing, and returning 0 would read
 *         as "fast" — the most permissive possible answer to "we have no data", which is the
 *         inversion §14 forbids.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    throw new Error('[slo] percentile of an empty sample set. No data is not a fast system.');
  }
  if (p <= 0 || p > 100) {
    throw new Error(`[slo] percentile ${p} is outside (0, 100]`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1];
}

/**
 * Whether an objective is met, and how it is not met.
 *
 * A discriminated union rather than a boolean, so a caller cannot treat "we have no samples"
 * as "the objective is met". They are different facts and only one of them is good news.
 */
export type SloStatus =
  | { readonly kind: 'MET'; readonly operation: SloOperation; readonly observedMs: number }
  | {
      readonly kind: 'BREACHED';
      readonly operation: SloOperation;
      readonly observedMs: number;
      readonly budgetMs: number;
      readonly percentile: number;
      readonly samples: number;
    }
  | { readonly kind: 'NO_DATA'; readonly operation: SloOperation; readonly why: string };

/**
 * How many samples a window must hold before a percentile is worth acting on.
 *
 * With three samples a p95 is the slowest of the three, and one slow request would page someone
 * — the single-sample behaviour this replaces, wearing a percentile. Below the floor the answer
 * is NO_DATA, which is honest and is not "MET".
 */
export const MIN_SAMPLES = 20;

export function evaluateSlo(
  operation: SloOperation,
  samples: readonly number[]
): SloStatus {
  const slo = sloFor(operation);
  if (samples.length < MIN_SAMPLES) {
    return {
      kind: 'NO_DATA',
      operation,
      why:
        `${samples.length} sample(s) in the window; at least ${MIN_SAMPLES} are needed before a ` +
        `p${slo.percentile} means anything. This is NOT the objective being met.`,
    };
  }
  const observedMs = percentile(samples, slo.percentile);
  if (observedMs > slo.budgetMs) {
    return {
      kind: 'BREACHED',
      operation,
      observedMs,
      budgetMs: slo.budgetMs,
      percentile: slo.percentile,
      samples: samples.length,
    };
  }
  return { kind: 'MET', operation, observedMs };
}
