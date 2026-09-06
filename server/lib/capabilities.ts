/**
 * P1.11 — Capability records, and a pre-flight `assertCapability`.
 *
 * WHAT WAS WRONG
 * --------------
 * The gateway's only question before sending was "is there an access token?". Whether that
 * token was ever granted permission to send was never asked, because the granted scopes were
 * never stored: the `oauth_connections` record holds `accessToken`, `accountEmail`, `expiresAt`
 * and `status`, and nothing else.
 *
 * So a token issued for `gmail.readonly` reached the send path and failed at Google with a 403,
 * after the action had been dispatched, logged as attempted, and counted against the outbox.
 * The failure is discovered by the provider rather than by us, one network round trip too late
 * — and a 403 for missing scope is not retryable, so every retry burned an attempt to learn the
 * same thing again.
 *
 * THE RULE
 * --------
 * A capability is granted only by a scope we recorded at consent time. Absent scopes are NOT a
 * blank cheque: a record that does not say what it may do is refused, and the operator is told
 * to reconnect. §14 — unknown must never default to permission — and §A — production action
 * flags must fail closed. Both point the same way, and the direction is "no".
 */

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  'EMAIL_SEND',
  'EMAIL_READ',
  'EMAIL_MODIFY',
  'CALENDAR_READ',
  'CALENDAR_WRITE',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * Scope -> capabilities. Written out per scope; a scope absent from this table grants nothing,
 * which is the safe direction for a provider that adds one we have not reviewed.
 */
const SCOPE_GRANTS: Readonly<Record<string, readonly Capability[]>> = Object.freeze({
  'https://www.googleapis.com/auth/gmail.send': ['EMAIL_SEND'],
  'https://www.googleapis.com/auth/gmail.readonly': ['EMAIL_READ'],
  'https://www.googleapis.com/auth/gmail.modify': ['EMAIL_SEND', 'EMAIL_READ', 'EMAIL_MODIFY'],
  'https://www.googleapis.com/auth/gmail.compose': ['EMAIL_SEND', 'EMAIL_MODIFY'],
  'https://mail.google.com/': ['EMAIL_SEND', 'EMAIL_READ', 'EMAIL_MODIFY'],
  'https://www.googleapis.com/auth/calendar': ['CALENDAR_READ', 'CALENDAR_WRITE'],
  'https://www.googleapis.com/auth/calendar.events': ['CALENDAR_READ', 'CALENDAR_WRITE'],
  'https://www.googleapis.com/auth/calendar.readonly': ['CALENDAR_READ'],
  'https://www.googleapis.com/auth/calendar.events.readonly': ['CALENDAR_READ'],
});

/** The scopes this application should request, so consent and enforcement cannot drift apart. */
export const REQUESTED_SCOPES: readonly string[] = Object.freeze([
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]);

export interface ProviderConnection {
  readonly provider: string;
  readonly organizationId: string;
  /**
   * Scopes recorded at consent. `null`/`undefined` means "we did not record them", which is
   * NOT the same as "none" and is emphatically not "all" — both are refused, with different
   * messages, because the fix differs.
   */
  readonly scopes?: readonly string[] | null;
  readonly status?: string | null;
  readonly expiresAt?: Date | string | null;
}

export type CapabilityVerdict =
  | { readonly granted: true; readonly via: string }
  | {
      readonly granted: false;
      readonly reason:
        | 'NO_SCOPES_RECORDED'
        | 'SCOPE_NOT_GRANTED'
        | 'CONNECTION_INACTIVE'
        | 'CREDENTIAL_EXPIRED';
      readonly detail: string;
    };

export function capabilitiesOf(scopes: readonly string[]): Set<Capability> {
  const granted = new Set<Capability>();
  for (const scope of scopes) {
    const entries = SCOPE_GRANTS[scope];
    if (entries === undefined) continue; // an unreviewed scope grants nothing
    for (const capability of entries) granted.add(capability);
  }
  return granted;
}

/**
 * Can this connection do this thing? Answered before any request leaves the process.
 *
 * `now` is injected rather than read, so an expiry boundary is testable (P1.9's rule).
 */
export function checkCapability(
  connection: ProviderConnection,
  capability: Capability,
  now: Date
): CapabilityVerdict {
  if (connection.status !== undefined && connection.status !== null && connection.status !== 'ACTIVE') {
    return {
      granted: false,
      reason: 'CONNECTION_INACTIVE',
      detail: `The ${connection.provider} connection is ${connection.status}, not ACTIVE.`,
    };
  }

  // An absent expiry means unknown, not "never expires" — but a *known* past expiry is a
  // definite refusal, and the caller should refresh rather than dispatch.
  if (connection.expiresAt !== undefined && connection.expiresAt !== null) {
    const expires =
      connection.expiresAt instanceof Date ? connection.expiresAt : new Date(connection.expiresAt);
    if (!Number.isNaN(expires.getTime()) && expires.getTime() <= now.getTime()) {
      return {
        granted: false,
        reason: 'CREDENTIAL_EXPIRED',
        detail: `The ${connection.provider} credential expired at ${expires.toISOString()}.`,
      };
    }
  }

  if (connection.scopes === undefined || connection.scopes === null) {
    return {
      granted: false,
      reason: 'NO_SCOPES_RECORDED',
      detail:
        `The ${connection.provider} connection does not record which scopes were granted, so ` +
        `there is no evidence it may ${capability}. Reconnect the account to record them. ` +
        'An unrecorded grant is not a grant.',
    };
  }

  const granted = capabilitiesOf(connection.scopes);
  if (!granted.has(capability)) {
    return {
      granted: false,
      reason: 'SCOPE_NOT_GRANTED',
      detail:
        `The ${connection.provider} connection was granted [${connection.scopes.join(', ')}], ` +
        `which does not include ${capability}. Retrying cannot change this; the account must be ` +
        'reconnected with the required scope.',
    };
  }

  const via = connection.scopes.find((scope) => (SCOPE_GRANTS[scope] ?? []).includes(capability));
  return { granted: true, via: via ?? 'unknown' };
}

export class CapabilityError extends Error {
  readonly reason: string;
  readonly capability: Capability;
  readonly provider: string;
  /** Missing scope is never fixed by trying again. */
  readonly retryable = false;

  constructor(provider: string, capability: Capability, reason: string, detail: string) {
    super(detail);
    this.name = 'CapabilityError';
    this.provider = provider;
    this.capability = capability;
    this.reason = reason;
  }
}

/** Throwing form, for the pre-flight in the gateway. */
export function assertCapability(
  connection: ProviderConnection,
  capability: Capability,
  now: Date
): void {
  const verdict = checkCapability(connection, capability, now);
  if (verdict.granted === false) {
    throw new CapabilityError(connection.provider, capability, verdict.reason, verdict.detail);
  }
}

/**
 * Normalise whatever the datastore held into a scope list.
 *
 * Google returns granted scopes as one space-delimited string; some records may hold an array.
 * Anything else yields `null` — meaning "not recorded" — rather than an empty array, because an
 * empty array would read as "we know it has no scopes" and this is "we do not know".
 */
export function normalizeScopes(value: unknown): string[] | null {
  if (typeof value === 'string') {
    const parts = value.split(/[\s,]+/).filter((s) => s.length > 0);
    return parts.length > 0 ? parts : null;
  }
  if (Array.isArray(value)) {
    const parts = value.filter((s): s is string => typeof s === 'string' && s.length > 0);
    return parts.length > 0 ? parts : null;
  }
  return null;
}
