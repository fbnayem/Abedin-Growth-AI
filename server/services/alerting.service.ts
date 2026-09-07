/**
 * S44 — where an alert goes, and what happens when it has nowhere to go.
 *
 * WHAT WAS THERE
 * --------------
 * One threshold whose destination was stdout:
 *
 *     if (durationMs > 2000) console.warn('[SLO ALERT] ...')   // "In production, send to Datadog"
 *
 * and `incrementCounter`, whose body was empty, so `DUPLICATE_BLOCKED` and `POLICY_BLOCK` were
 * declared metric names that were discarded. No PagerDuty, Slack, Sentry, Datadog or Cloud
 * Monitoring client appears in the dependencies.
 *
 * THE PART THAT MATTERS MORE THAN THE TRANSPORT
 * ---------------------------------------------
 * No destination is configured in this deployment, and there is no credential here to configure
 * one with. So the question this module has to answer honestly is not "how do we page someone"
 * but "what do we do when we cannot".
 *
 * An alert that cannot be delivered is NOT delivered. `raise()` returns the outcome rather than
 * a boolean or nothing at all, `UNDELIVERED` is a distinct result from `DELIVERED`, and the
 * undelivered ones are kept so `undelivered()` can report them — to a readiness endpoint, to an
 * operator, to a test. The failure this replaces is a system that believes it is monitored.
 *
 * The one thing this module will not do is return quietly. S44's worst case is a worker that
 * dies at 02:00 with nothing recording a heartbeat and no alert having a destination; an
 * alerting module that swallowed its own failure would be the same defect one level up.
 */

export const ALERT_SEVERITIES = ['WARNING', 'PAGE'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export interface Alert {
  /** Stable identifier for the condition, so repeats can be recognised. */
  readonly signal: string;
  readonly severity: AlertSeverity;
  readonly summary: string;
  /** Whatever a responder needs. Never an object that only makes sense inside this process. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  readonly at: number;
}

export type Delivery =
  | { readonly kind: 'DELIVERED'; readonly destination: string }
  | { readonly kind: 'UNDELIVERED'; readonly why: string };

/** Anything that can take an alert somewhere. Injected, so a test can be the destination. */
export interface AlertTransport {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

/**
 * A transport built from the environment, or none.
 *
 * `ALERT_WEBHOOK_URL` is deliberately generic — Slack, Teams, PagerDuty Events and Opsgenie all
 * accept a JSON POST — so that configuring alerting is one variable rather than a client
 * library and a credential per vendor.
 */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): AlertTransport | null {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return null;
  return {
    name: `webhook(${new URL(url).host})`,
    async send(alert: Alert): Promise<void> {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: `[${alert.severity}] ${alert.signal}: ${alert.summary}`,
          alert,
        }),
        // An alerting call that hangs is an alert that never arrives, and the caller is usually
        // already handling something worse.
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`alert webhook answered ${response.status}`);
      }
    },
  };
}

export class AlertingService {
  /**
   * Alerts that were raised and did not reach anywhere.
   *
   * Bounded, because an unbounded list in a process that cannot alert is a memory leak in the
   * exact situation where nobody is watching. The count is kept separately so the number is
   * still right after the list is trimmed — a truncated list that also under-reports its own
   * length would understate an outage.
   */
  private readonly undeliveredAlerts: Alert[] = [];
  private undeliveredCount = 0;
  private static readonly KEEP = 50;

  constructor(private transport: AlertTransport | null = transportFromEnv()) {}

  /** Replace the destination. Used by tests and by a deployment that configures one late. */
  setTransport(transport: AlertTransport | null): void {
    this.transport = transport;
  }

  hasDestination(): boolean {
    return this.transport !== null;
  }

  destinationName(): string | null {
    return this.transport?.name ?? null;
  }

  async raise(alert: Alert): Promise<Delivery> {
    if (this.transport === null) {
      this.record(alert);
      // Still printed, because stdout is the only thing left — but the RETURN VALUE says
      // undelivered, so no caller can read a log line as delivery.
      console.error(
        `[alerting] NO DESTINATION CONFIGURED. ${alert.severity} ${alert.signal}: ${alert.summary}`
      );
      return {
        kind: 'UNDELIVERED',
        why:
          'ALERT_WEBHOOK_URL is not set, so this alert reached nobody. It was written to stdout ' +
          'and counted, which is not the same as being delivered.',
      };
    }

    try {
      await this.transport.send(alert);
      return { kind: 'DELIVERED', destination: this.transport.name };
    } catch (e) {
      this.record(alert);
      console.error(
        `[alerting] delivery FAILED to ${this.transport.name}: ${(e as Error).message}. ` +
          `${alert.severity} ${alert.signal}: ${alert.summary}`
      );
      return { kind: 'UNDELIVERED', why: `transport failed: ${(e as Error).message}` };
    }
  }

  private record(alert: Alert): void {
    this.undeliveredCount++;
    this.undeliveredAlerts.push(alert);
    if (this.undeliveredAlerts.length > AlertingService.KEEP) this.undeliveredAlerts.shift();
  }

  /** What has been raised and not delivered. For a readiness endpoint and for an operator. */
  undelivered(): { count: number; kept: readonly Alert[] } {
    return { count: this.undeliveredCount, kept: [...this.undeliveredAlerts] };
  }

  reset(): void {
    this.undeliveredAlerts.length = 0;
    this.undeliveredCount = 0;
  }
}

export const alertingService = new AlertingService();
