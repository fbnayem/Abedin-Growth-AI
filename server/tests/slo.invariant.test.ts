import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import {
  SLOS,
  SLO_OPERATIONS,
  MIN_SAMPLES,
  evaluateSlo,
  percentile,
  sloFor,
} from '../domain/slo';
import { MetricsService, COUNTER_METRICS } from '../services/metrics.service';
import { AlertingService, transportFromEnv, type Alert } from '../services/alerting.service';

/**
 * S44/S45 — A METRIC THAT IS DISCARDED, AND AN ALERT WITH NOWHERE TO GO.
 *
 * `incrementCounter` had an empty function body. `DUPLICATE_BLOCKED` and `POLICY_BLOCK` were
 * declared metric names counted nowhere, and the method had zero call sites anyway, so nothing
 * revealed it by being wrong. `recordLatency` compared every operation against a shared `2000`
 * and printed to stdout under the comment "In production, send to Datadog / Prometheus", and its
 * single call site sat downstream of a database call that always threw.
 *
 * The string "SLO" appeared once in the repository, inside that `console.warn`.
 *
 * A discarded metric is worse than an absent one: "do we have metrics?" gets answered by the
 * service existing, and nobody asks whether the numbers do.
 */

const now = { t: 1_700_000_000_000 };
const metrics = new (MetricsService as unknown as new () => MetricsService)();

beforeEach(() => {
  now.t = 1_700_000_000_000;
  metrics.reset();
  metrics.setClock(() => now.t);
});

// ===========================================================================
describe('1. the objectives are written down once', () => {
  /**
   * The document is the readable version and `slo.ts` is the executable one. A target changed in
   * one and not the other is a document nobody can trust, which is how the shared `2000` came to
   * be the only number in the system.
   */
  it('every objective in slo.ts appears in docs/production/slo.md with the same numbers', () => {
    const doc = readFileSync('docs/production/slo.md', 'utf8');
    for (const operation of SLO_OPERATIONS) {
      const slo = SLOS[operation];
      expect(doc).toContain(operation);

      // The same VALUE, in either unit the document might reasonably write it in. Pinning one
      // spelling would make this a test of the document's formatting, and the next person to
      // write "120s" as "2m" would be told they had changed an objective they had not.
      const seconds = slo.budgetMs / 1000;
      const spellings = [`${seconds}s`];
      if (Number.isInteger(seconds / 60)) spellings.push(`${seconds / 60}m`);

      // Scoped to the table ROW for this operation. Searching the whole document let two
      // objectives satisfy each other's assertion: changing DRAFT_GENERATION's budget from 30s
      // to 60s passed, because INBOUND_PROCESSING's row already said "p95 < 60s" somewhere.
      const row = doc.split('\n').find((line) => line.includes(`\`${operation}\``) && line.includes('|'));
      expect(row, `no table row in docs/production/slo.md for ${operation}`).toBeTruthy();

      const stated = spellings.some((spelling) =>
        new RegExp(`p${slo.percentile}\\s*<\\s*${spelling}\\b`).test(row as string)
      );
      expect(
        stated,
        `docs/production/slo.md does not state ${operation} as p${slo.percentile} < ` +
          spellings.join(' or ')
      ).toBe(true);
    }
  });

  it('every objective states a percentile, a window and a reason', () => {
    for (const operation of SLO_OPERATIONS) {
      const slo = sloFor(operation);
      expect([50, 95, 99]).toContain(slo.percentile);
      expect(slo.budgetMs).toBeGreaterThan(0);
      expect(slo.windowMs).toBeGreaterThan(0);
      expect(slo.rationale.length).toBeGreaterThan(30);
    }
  });

  /**
   * A fallback budget would mean a new operation is silently measured against a number chosen
   * for something else — which is precisely what the shared 2000 was.
   */
  it('an unknown operation throws rather than getting a default budget', () => {
    expect(() => sloFor('SOMETHING_NEW' as never)).toThrow(/no objective/);
  });

  it('the operations no longer share one number', () => {
    const budgets = new Set(SLO_OPERATIONS.map((o) => SLOS[o].budgetMs));
    expect(budgets.size).toBeGreaterThan(1);
  });
});

// ===========================================================================
describe('2. no data is not a healthy system', () => {
  /**
   * The inversion this whole file exists against. An empty window reporting MET is the same
   * shape as a suppression check reporting clean from an empty store: unknown resolving to the
   * permissive answer.
   */
  it('an empty window is NO_DATA, not MET', () => {
    expect(evaluateSlo('INBOUND_PROCESSING', []).kind).toBe('NO_DATA');
  });

  it('too few samples is NO_DATA, however fast they were', () => {
    const fast = Array.from({ length: MIN_SAMPLES - 1 }, () => 1);
    const status = evaluateSlo('INBOUND_PROCESSING', fast);
    expect(status.kind).toBe('NO_DATA');
    expect(status.kind === 'NO_DATA' && status.why).toMatch(/NOT the objective being met/);
  });

  it('at the floor it becomes answerable', () => {
    const fast = Array.from({ length: MIN_SAMPLES }, () => 1);
    expect(evaluateSlo('INBOUND_PROCESSING', fast).kind).toBe('MET');
  });

  /**
   * The floor has to be high enough to mean something. With a handful of samples a p95 is just
   * the slowest of them, so one slow request would page someone — the single-sample behaviour
   * this replaces, wearing a percentile.
   *
   * Written after a mutation run: lowering MIN_SAMPLES to 1 survived every other assertion here,
   * because each one derives its sample count FROM the constant and so moves with it.
   */
  it('a handful of samples cannot page anyone, however slow one of them was', () => {
    const handful = [10, 10, 10, 10, 999_999];
    expect(evaluateSlo('INBOUND_PROCESSING', handful).kind).toBe('NO_DATA');
  });

  it('the floor is a real threshold, not a formality', () => {
    expect(MIN_SAMPLES).toBeGreaterThanOrEqual(20);
  });

  /** Returning 0 for an empty set would read as "fast" — the most permissive possible answer. */
  it('a percentile of nothing throws rather than answering zero', () => {
    expect(() => percentile([], 95)).toThrow(/No data is not a fast system/);
  });
});

// ===========================================================================
describe('3. a percentile, not a single sample', () => {
  /**
   * The old form fired on any sample over 2000ms. One slow request pages someone, and — the
   * direction nobody notices — a system slow half the time never breaches, because each sample
   * is judged alone.
   */
  it('one slow request among many does not breach', () => {
    const samples = [...Array.from({ length: 99 }, () => 10), 999_999];
    expect(evaluateSlo('INBOUND_PROCESSING', samples).kind).toBe('MET');
  });

  it('a system that is slow most of the time does breach', () => {
    const samples = Array.from({ length: 100 }, () => 90_000);
    const status = evaluateSlo('INBOUND_PROCESSING', samples);
    expect(status.kind).toBe('BREACHED');
    expect(status.kind === 'BREACHED' && status.observedMs).toBe(90_000);
    expect(status.kind === 'BREACHED' && status.budgetMs).toBe(60_000);
  });

  /** Nearest-rank: the answer names a request that actually took that long. */
  it('the reported value is an observed measurement, not an interpolation', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const p95 = percentile(samples, 95);
    expect(samples).toContain(p95);
    expect(p95).toBe(10);
  });

  it('p50 of an even set is a real sample too', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it('a percentile outside (0, 100] is refused', () => {
    for (const p of [0, -1, 101]) expect(() => percentile([1, 2, 3], p)).toThrow();
  });
});

// ===========================================================================
describe('4. the counters have a body', () => {
  it('increments, which the empty implementation did not', () => {
    metrics.incrementCounter('DUPLICATE_BLOCKED');
    metrics.incrementCounter('DUPLICATE_BLOCKED');
    metrics.incrementCounter('POLICY_BLOCK', 3);
    expect(metrics.counter('DUPLICATE_BLOCKED')).toBe(2);
    expect(metrics.counter('POLICY_BLOCK')).toBe(3);
  });

  it('an untouched counter is zero, and appears in the snapshot as zero', () => {
    const snapshot = metrics.snapshot();
    for (const m of COUNTER_METRICS) expect(snapshot.counters[m]).toBe(0);
  });

  it('the vocabulary covers the failure signals, not only the success one', () => {
    for (const signal of ['SEND_FAILURE', 'DEAD_LETTERED', 'PROVIDER_401', 'PROVIDER_429']) {
      expect(COUNTER_METRICS).toContain(signal);
    }
  });
});

// ===========================================================================
describe('5. latency is windowed, and a nonsense duration is refused', () => {
  it('samples outside the operation window are not counted', () => {
    for (let i = 0; i < MIN_SAMPLES; i++) metrics.recordLatency('INBOUND_PROCESSING', 10);
    expect(metrics.evaluate().find((s) => s.operation === 'INBOUND_PROCESSING')?.kind).toBe('MET');

    // Move past the one-hour window; the same samples are now too old to answer with.
    now.t += SLOS.INBOUND_PROCESSING.windowMs + 1;
    expect(metrics.evaluate().find((s) => s.operation === 'INBOUND_PROCESSING')?.kind).toBe(
      'NO_DATA'
    );
  });

  /**
   * A negative or NaN duration usually means two clocks were subtracted across a boundary.
   * Storing it would move the percentile in the reassuring direction.
   */
  it('a negative or non-finite duration is not recorded', () => {
    // Enough bad samples to MOVE the percentile if they were kept. An earlier version added two
    // to twenty good ones, where the p95 landed on a good sample either way — so the assertion
    // held whether or not the guard existed, which a mutation run showed.
    for (let i = 0; i < MIN_SAMPLES; i++) metrics.recordLatency('INBOUND_PROCESSING', 90_000);
    for (let i = 0; i < MIN_SAMPLES * 5; i++) {
      metrics.recordLatency('INBOUND_PROCESSING', -1);
      metrics.recordLatency('INBOUND_PROCESSING', NaN);
    }
    const status = metrics.evaluate().find((s) => s.operation === 'INBOUND_PROCESSING');
    // Still breaching on the twenty real samples. If the negatives had been kept they would
    // outnumber them five to one and drag the p95 down to -1, reporting a healthy system.
    expect(status?.kind).toBe('BREACHED');
    expect(status?.kind === 'BREACHED' && status.observedMs).toBe(90_000);
    expect(status?.kind === 'BREACHED' && status.samples).toBe(MIN_SAMPLES);
  });

  it('every objective appears in an evaluation, including the ones with no data', () => {
    expect(metrics.evaluate().map((s) => s.operation).sort()).toEqual([...SLO_OPERATIONS].sort());
  });
});

// ===========================================================================
describe('6. an alert that reaches nobody says so', () => {
  const alert: Alert = {
    signal: 'TEST',
    severity: 'PAGE',
    summary: 'something broke',
    detail: { n: 1 },
    at: 0,
  };

  /**
   * The property that matters more than the transport. No destination is configured in this
   * deployment, and a module that returned quietly would leave the system believing it is
   * monitored — which is S44's worst case exactly.
   */
  it('with no destination the result is UNDELIVERED, not silence', async () => {
    const service = new AlertingService(null);
    const delivery = await service.raise(alert);
    expect(delivery.kind).toBe('UNDELIVERED');
    expect(delivery.kind === 'UNDELIVERED' && delivery.why).toMatch(/reached nobody/);
    expect(service.hasDestination()).toBe(false);
  });

  it('undelivered alerts are counted and kept, so the gap is reportable', async () => {
    const service = new AlertingService(null);
    await service.raise(alert);
    await service.raise(alert);
    expect(service.undelivered().count).toBe(2);
    expect(service.undelivered().kept).toHaveLength(2);
  });

  it('a transport that throws is UNDELIVERED too, not a swallowed exception', async () => {
    const service = new AlertingService({
      name: 'broken',
      async send() {
        throw new Error('connection refused');
      },
    });
    const delivery = await service.raise(alert);
    expect(delivery.kind).toBe('UNDELIVERED');
    expect(delivery.kind === 'UNDELIVERED' && delivery.why).toMatch(/connection refused/);
    expect(service.undelivered().count).toBe(1);
  });

  it('a working transport receives the alert and reports DELIVERED', async () => {
    const received: Alert[] = [];
    const service = new AlertingService({
      name: 'test-sink',
      async send(a) {
        received.push(a);
      },
    });
    const delivery = await service.raise(alert);
    expect(delivery).toEqual({ kind: 'DELIVERED', destination: 'test-sink' });
    expect(received).toEqual([alert]);
    expect(service.undelivered().count).toBe(0);
  });

  it('the kept list is bounded, so a process nobody is watching does not grow without limit', async () => {
    const service = new AlertingService(null);
    for (let i = 0; i < 60; i++) await service.raise(alert);
    // The count is exact even though the list is trimmed: a truncated list that also
    // under-reported its own length would understate an outage.
    expect(service.undelivered().count).toBe(60);
    expect(service.undelivered().kept.length).toBeLessThanOrEqual(50);
  });

  it('no ALERT_WEBHOOK_URL means no transport, rather than a transport that goes nowhere', () => {
    expect(transportFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(transportFromEnv({ ALERT_WEBHOOK_URL: '  ' } as NodeJS.ProcessEnv)).toBeNull();
    expect(
      transportFromEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' } as NodeJS.ProcessEnv)
        ?.name
    ).toContain('hooks.example.com');
  });
});

// ===========================================================================
describe('7. a breach raises an alert, and the outcome is reported', () => {
  it('a breached objective produces an alert carrying the numbers', async () => {
    const received: Alert[] = [];
    const service = new AlertingService({
      name: 'test-sink',
      async send(a) {
        received.push(a);
      },
    });
    // The module-level singleton is what evaluateAndAlert uses.
    const { alertingService } = await import('../services/alerting.service');
    alertingService.setTransport(service['transport' as never] ?? null);
    alertingService.setTransport({
      name: 'test-sink',
      async send(a: Alert) {
        received.push(a);
      },
    });
    alertingService.reset();

    for (let i = 0; i < MIN_SAMPLES; i++) metrics.recordLatency('INBOUND_PROCESSING', 90_000);
    const results = await metrics.evaluateAndAlert();

    expect(results).toHaveLength(1);
    expect(results[0].delivery.kind).toBe('DELIVERED');
    expect(received).toHaveLength(1);
    expect(received[0].signal).toBe('SLO_BREACH:INBOUND_PROCESSING');
    expect(received[0].detail.observedMs).toBe(90_000);
    expect(received[0].detail.budgetMs).toBe(60_000);

    alertingService.setTransport(null);
  });

  it('an objective that is met raises nothing', async () => {
    for (let i = 0; i < MIN_SAMPLES; i++) metrics.recordLatency('INBOUND_PROCESSING', 10);
    expect(await metrics.evaluateAndAlert()).toEqual([]);
  });

  /** NO_DATA must not page anyone either. It is a gap, not a breach. */
  it('an objective with no data raises nothing', async () => {
    expect(await metrics.evaluateAndAlert()).toEqual([]);
  });
});

// ===========================================================================
/**
 * The emit has to be on the failure path, or the percentile describes only the requests that
 * worked — most reassuring exactly when it matters least.
 */
describe('8. the pipeline measures its failures too', () => {
  const pipeline = readFileSync('server/services/inboundPipeline.ts', 'utf8');

  it('the latency emit is in a finally, not before the successful return', () => {
    expect(pipeline).toMatch(/\}\s*finally\s*\{[\s\S]{0,600}recordLatency\('INBOUND_PROCESSING'/);
  });

  it('the failure path increments a counter rather than only logging', () => {
    expect(pipeline).toMatch(/incrementCounter\('AI_FAILURE'\)/);
  });

  it('the clock starts outside the try, so a failure before it is still measured', () => {
    const declaration = pipeline.indexOf('const startTime = Date.now();');
    const tryAt = pipeline.indexOf('try {', declaration - 400);
    expect(declaration).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(tryAt);
  });
});
