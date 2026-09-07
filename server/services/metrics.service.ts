import {
  evaluateSlo,
  sloFor,
  SLO_OPERATIONS,
  type SloOperation,
  type SloStatus,
} from '../domain/slo';
import { alertingService, type Delivery } from './alerting.service';

/**
 * S44/S45 — the metrics this system actually keeps.
 *
 * WHAT WAS HERE
 * -------------
 * Twenty-one lines. `recordLatency` compared every operation against a shared `2000` and printed
 * to stdout under the comment "In production, send to Datadog / Prometheus". `incrementCounter`
 * had an **empty function body**, so `DUPLICATE_BLOCKED` and `POLICY_BLOCK` were declared metric
 * names that were discarded — and it had zero call sites anyway. The single `recordLatency` call
 * sat downstream of a database call that always threw, so it never executed.
 *
 * That is the shape this repository keeps finding: a component that exists, compiles, is named
 * after what it should do, and does nothing. A metric that is discarded is worse than an absent
 * one, because "we have metrics" is then true in the only sense anyone checks.
 *
 * WHAT IT DOES NOW
 * ----------------
 * Counters have a body. Latencies go into a bounded, time-windowed buffer per operation, and the
 * objective is evaluated as a PERCENTILE over that window rather than fired on a single sample.
 * The single-sample form was wrong in both directions: one slow request pages someone, and a
 * system that is slow half the time never breaches because each sample is judged alone.
 *
 * Below `MIN_SAMPLES` the answer is NO_DATA, which is not MET. A monitoring system that reports
 * health from an empty window is the same inversion as a suppression check that reports clean
 * from an empty store.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a metrics backend. There is no Prometheus, Datadog or Cloud Monitoring client here,
 * and this keeps its own numbers in memory, which means they are lost on restart and are not
 * aggregated across replicas. That is a real limitation and it is stated rather than implied
 * away: what this fixes is metrics being discarded and objectives being unwritten, not the
 * absence of a metrics platform.
 */

export const COUNTER_METRICS = [
  'SEND_SUCCESS',
  'SEND_FAILURE',
  'DUPLICATE_BLOCKED',
  'POLICY_BLOCK',
  'DEAD_LETTERED',
  'PROVIDER_401',
  'PROVIDER_429',
  'AI_FAILURE',
  'WEBHOOK_REJECTED',
  'AMBIGUOUS_OUTCOME',
] as const;

export type CounterMetric = (typeof COUNTER_METRICS)[number];

interface Sample {
  readonly at: number;
  readonly ms: number;
}

/** Per operation. Enough to compute a p99 over an hour of ordinary traffic without growing. */
const MAX_SAMPLES = 2000;

export class MetricsService {
  private static instance: MetricsService;

  private readonly counters = new Map<CounterMetric, number>();
  private readonly latencies = new Map<SloOperation, Sample[]>();
  /** Injected so a latency window can be tested without waiting an hour. */
  private clock: () => number = () => Date.now();

  static getInstance(): MetricsService {
    if (!this.instance) this.instance = new MetricsService();
    return this.instance;
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  /**
   * Record how long an operation took.
   *
   * No threshold comparison here. A single sample is not a percentile, and the objective is
   * evaluated over a window by `evaluate()`.
   */
  recordLatency(operation: SloOperation, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      // A negative or NaN duration usually means two clocks were subtracted across a boundary.
      // Storing it would move the percentile in the reassuring direction.
      console.warn(`[metrics] refusing a ${operation} duration of ${durationMs}`);
      return;
    }
    const samples = this.latencies.get(operation) ?? [];
    samples.push({ at: this.clock(), ms: durationMs });
    if (samples.length > MAX_SAMPLES) samples.shift();
    this.latencies.set(operation, samples);
  }

  /** This used to be an empty function body. */
  incrementCounter(metric: CounterMetric, by = 1): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + by);
  }

  counter(metric: CounterMetric): number {
    return this.counters.get(metric) ?? 0;
  }

  /** Samples inside the operation's own window. Windows differ per objective. */
  private windowed(operation: SloOperation): number[] {
    const cutoff = this.clock() - sloFor(operation).windowMs;
    return (this.latencies.get(operation) ?? [])
      .filter((s) => s.at >= cutoff)
      .map((s) => s.ms);
  }

  /** Every objective, evaluated. Includes the ones with no data, said as NO_DATA. */
  evaluate(): SloStatus[] {
    return SLO_OPERATIONS.map((operation) => evaluateSlo(operation, this.windowed(operation)));
  }

  /**
   * Evaluate, and raise an alert for each breach.
   *
   * Returns what happened to each alert, because "we evaluated and there were breaches" and
   * "somebody was told" are different claims and the second is the one that matters at 02:00.
   */
  async evaluateAndAlert(): Promise<{ status: SloStatus; delivery: Delivery }[]> {
    const out: { status: SloStatus; delivery: Delivery }[] = [];
    for (const status of this.evaluate()) {
      if (status.kind !== 'BREACHED') continue;
      const delivery = await alertingService.raise({
        signal: `SLO_BREACH:${status.operation}`,
        severity: 'PAGE',
        summary:
          `${status.operation} p${status.percentile} is ${status.observedMs}ms against a budget ` +
          `of ${status.budgetMs}ms`,
        detail: {
          operation: status.operation,
          observedMs: status.observedMs,
          budgetMs: status.budgetMs,
          percentile: status.percentile,
          samples: status.samples,
        },
        at: this.clock(),
      });
      out.push({ status, delivery });
    }
    return out;
  }

  /** Everything, for a readiness endpoint or an operator. */
  snapshot(): {
    counters: Record<string, number>;
    slos: SloStatus[];
    alerting: { configured: boolean; destination: string | null; undelivered: number };
  } {
    return {
      counters: Object.fromEntries(
        COUNTER_METRICS.map((m) => [m, this.counters.get(m) ?? 0])
      ),
      slos: this.evaluate(),
      alerting: {
        configured: alertingService.hasDestination(),
        destination: alertingService.destinationName(),
        undelivered: alertingService.undelivered().count,
      },
    };
  }

  reset(): void {
    this.counters.clear();
    this.latencies.clear();
  }
}

export const metricsService = MetricsService.getInstance();
