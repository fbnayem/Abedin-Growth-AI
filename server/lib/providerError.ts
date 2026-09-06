/**
 * P1.11 — One normalized provider error, classified from structure rather than from prose.
 *
 * WHAT WAS WRONG
 * --------------
 * The gateway decided whether a failed irreversible action was AMBIGUOUS — the §32 question,
 * "might the provider have done it anyway?" — like this:
 *
 *     const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');
 *
 * That control is inverted in both directions, and it was measured, not reasoned about:
 *
 *   - `fetchWithTimeout` throws `HttpTimeoutError`, whose message is
 *     "Request to <url> timed out after 15000ms". **"timed out" does not contain "timeout".**
 *     So the one timeout error this codebase actually raises classified as a DEFINITE FAILURE.
 *     Every real provider failure did: "fetch failed", "socket hang up", "read ECONNRESET",
 *     "Rate Limit Exceeded", "Backend Error", "504 Gateway Timeout" — none of them match.
 *
 *   - A message containing the word "timeout" or "network" DOES match. Provider errors quote
 *     request content, so a customer who writes "timeout" in an email subject could steer the
 *     classification. §18: externally supplied text must never gain control over a decision.
 *
 * The consequence is the exact failure §32 exists to prevent. A Gmail send that timed out —
 * where the message may well have been delivered — was recorded as a definite failure and
 * became eligible for retry. The prospect gets the email twice, and nothing in the system knows.
 *
 * THE RULE
 * --------
 * Classification reads only structured signals: the error's own type, `code`/`cause.code`, and
 * the HTTP status. Never the message text. `UNKNOWN` is not a shrug — for an irreversible
 * action it resolves to AMBIGUOUS, because §14 says unknown must never default to permission,
 * and "permission" here is permission to retry something that may already have happened.
 */

import { HttpTimeoutError } from './httpClient';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export const PROVIDER_ERROR_KINDS = [
  'TIMEOUT',
  'CONNECTION_FAILED',
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INVALID_REQUEST',
  'CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'UNKNOWN',
] as const;

export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/**
 * What the caller is entitled to conclude about the *side effect*, which is a different question
 * from whether the call returned an error.
 *
 *   NOT_APPLIED — the provider rejected the request before acting on it. Safe to retry.
 *   AMBIGUOUS   — the request may have taken effect and we did not learn the outcome.
 *                 An irreversible action MUST be reconciled against the provider before retry.
 */
export type SideEffectOutcome = 'NOT_APPLIED' | 'AMBIGUOUS';

export interface KindDisposition {
  readonly outcome: SideEffectOutcome;
  /** Whether retrying is sensible at all — a 400 is our bug and will fail identically. */
  readonly retryable: boolean;
  /** Why, in one line, so a log entry explains itself. */
  readonly rationale: string;
}

/**
 * The table is the policy. It is written out per kind rather than derived, because every entry
 * is a decision somebody should be able to disagree with in review.
 */
export const KIND_DISPOSITION: Readonly<Record<ProviderErrorKind, KindDisposition>> = Object.freeze({
  TIMEOUT: {
    outcome: 'AMBIGUOUS',
    retryable: true,
    rationale:
      'No response arrived. The provider may have completed the request and the reply been lost. ' +
      'This is the §32 case: reconcile before retrying anything irreversible.',
  },
  CONNECTION_FAILED: {
    outcome: 'AMBIGUOUS',
    retryable: true,
    rationale:
      'The connection broke. A reset can happen after the request was fully sent and acted on, ' +
      'so this is not evidence that nothing happened.',
  },
  RATE_LIMITED: {
    outcome: 'NOT_APPLIED',
    retryable: true,
    rationale: 'The provider refused the request at the edge without processing it. Retry after the delay it asked for.',
  },
  UNAUTHENTICATED: {
    outcome: 'NOT_APPLIED',
    retryable: true,
    rationale: 'The credential was rejected, so nothing was done. Refresh the token, then retry.',
  },
  PERMISSION_DENIED: {
    outcome: 'NOT_APPLIED',
    retryable: false,
    rationale:
      'The credential is valid but lacks the scope. Retrying with the same credential fails ' +
      'identically; a human must re-consent.',
  },
  NOT_FOUND: {
    outcome: 'NOT_APPLIED',
    retryable: false,
    rationale: 'The target does not exist. Retrying cannot change that.',
  },
  INVALID_REQUEST: {
    outcome: 'NOT_APPLIED',
    retryable: false,
    rationale: 'The provider rejected the request as malformed. That is our defect, and a retry reproduces it.',
  },
  CONFLICT: {
    outcome: 'NOT_APPLIED',
    retryable: false,
    rationale: 'The provider refused because of existing state. Resolve the conflict rather than retrying.',
  },
  PROVIDER_UNAVAILABLE: {
    outcome: 'AMBIGUOUS',
    retryable: true,
    rationale:
      'A 5xx can come from a proxy AFTER the backend applied the change, so it is not proof of ' +
      'non-application.',
  },
  UNKNOWN: {
    outcome: 'AMBIGUOUS',
    retryable: true,
    rationale:
      'We could not classify this. §14: unknown must not default to permission, and treating it ' +
      'as a definite failure grants permission to retry something that may already have happened.',
  },
});

// ---------------------------------------------------------------------------
// The error
// ---------------------------------------------------------------------------

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  provider: string;
  operation: string;
  /** HTTP status, when the failure came from a response. */
  status?: number | null;
  /** Seconds the provider asked us to wait, from Retry-After. */
  retryAfterSeconds?: number | null;
  /** What the classification was based on — the evidence, not the prose. */
  signal: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly operation: string;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly signal: string;
  readonly cause: unknown;

  constructor(init: ProviderErrorInit) {
    super(`${init.provider}.${init.operation} failed: ${init.kind} (${init.signal})`);
    this.name = 'ProviderError';
    this.kind = init.kind;
    this.provider = init.provider;
    this.operation = init.operation;
    this.status = init.status ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.signal = init.signal;
    this.cause = init.cause;
  }

  get disposition(): KindDisposition {
    return KIND_DISPOSITION[this.kind];
  }

  /** Did the side effect maybe happen? The only question an irreversible retry may ask. */
  get outcome(): SideEffectOutcome {
    return this.disposition.outcome;
  }

  get isAmbiguous(): boolean {
    return this.outcome === 'AMBIGUOUS';
  }

  /**
   * Whether this action may be retried without first reconciling.
   *
   * `irreversible` is a required argument, not a default. A default would let a caller retry a
   * send by forgetting to say it was a send — and forgetting is the failure mode this exists
   * to stop.
   */
  mayRetryWithoutReconciliation(irreversible: boolean): boolean {
    if (!this.disposition.retryable) return false;
    if (irreversible && this.isAmbiguous) return false;
    return true;
  }

  /** A log-safe record. The provider's own text stays out: it can quote customer content (§18). */
  toLogRecord(): Record<string, unknown> {
    return {
      kind: this.kind,
      provider: this.provider,
      operation: this.operation,
      status: this.status,
      retryAfterSeconds: this.retryAfterSeconds,
      signal: this.signal,
      outcome: this.outcome,
      retryable: this.disposition.retryable,
    };
  }
}

// ---------------------------------------------------------------------------
// Classification — structured signals only
// ---------------------------------------------------------------------------

/** Node/undici socket-level codes, mapped by what they say about the side effect. */
const CONNECTION_CODES: Readonly<Record<string, ProviderErrorKind>> = Object.freeze({
  ETIMEDOUT: 'TIMEOUT',
  ESOCKETTIMEDOUT: 'TIMEOUT',
  UND_ERR_CONNECT_TIMEOUT: 'TIMEOUT',
  UND_ERR_HEADERS_TIMEOUT: 'TIMEOUT',
  UND_ERR_BODY_TIMEOUT: 'TIMEOUT',
  ECONNRESET: 'CONNECTION_FAILED',
  ECONNREFUSED: 'CONNECTION_FAILED',
  EPIPE: 'CONNECTION_FAILED',
  EHOSTUNREACH: 'CONNECTION_FAILED',
  ENETUNREACH: 'CONNECTION_FAILED',
  ENOTFOUND: 'CONNECTION_FAILED',
  EAI_AGAIN: 'CONNECTION_FAILED',
  UND_ERR_SOCKET: 'CONNECTION_FAILED',
  ECONNABORTED: 'CONNECTION_FAILED',
});

/**
 * HTTP status -> kind. Ranges rather than an exhaustive list, because a provider can invent a
 * status we have not seen and the range still says what class it is.
 */
export function kindForStatus(status: number): ProviderErrorKind {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 408) return 'TIMEOUT';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'PROVIDER_UNAVAILABLE';
  if (status >= 400 && status <= 499) return 'INVALID_REQUEST';
  return 'UNKNOWN';
}

/** `Retry-After` is either seconds or an HTTP date. Both are parsed; anything else is null. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const when = new Date(trimmed);
  if (Number.isNaN(when.getTime())) return null;
  const seconds = Math.round((when.getTime() - now.getTime()) / 1000);
  return seconds > 0 ? seconds : 0;
}

function readCode(error: unknown): string | null {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  if (candidate === null || candidate === undefined) return null;
  if (typeof candidate.code === 'string') return candidate.code;
  const causeCode = candidate.cause?.code;
  if (typeof causeCode === 'string') return causeCode;
  return null;
}

export interface ClassifyContext {
  provider: string;
  operation: string;
  now?: Date;
}

/**
 * Turn a thrown value into a ProviderError.
 *
 * Reads, in order: an existing ProviderError; the abort/timeout types; a socket code; nothing
 * else. There is deliberately no branch that inspects `message`.
 */
export function classifyThrown(error: unknown, context: ClassifyContext): ProviderError {
  if (error instanceof ProviderError) return error;

  const base = { provider: context.provider, operation: context.operation, cause: error };

  // The timeout this codebase raises, identified by TYPE — the substring test missed it because
  // its message says "timed out", not "timeout".
  if (error instanceof HttpTimeoutError) {
    return new ProviderError({ ...base, kind: 'TIMEOUT', signal: 'HttpTimeoutError' });
  }
  const named = error as { name?: unknown; isTimeout?: unknown } | null;
  if (named !== null && named !== undefined) {
    if (named.name === 'AbortError' || named.name === 'TimeoutError') {
      return new ProviderError({ ...base, kind: 'TIMEOUT', signal: `error.name=${String(named.name)}` });
    }
    if (named.isTimeout === true) {
      return new ProviderError({ ...base, kind: 'TIMEOUT', signal: 'error.isTimeout' });
    }
  }

  const code = readCode(error);
  if (code !== null) {
    const mapped = CONNECTION_CODES[code];
    if (mapped !== undefined) {
      return new ProviderError({ ...base, kind: mapped, signal: `code=${code}` });
    }
  }

  // Everything else is UNKNOWN, and UNKNOWN is AMBIGUOUS. Guessing from the text is how the
  // previous implementation came to treat every real failure as definitely-failed.
  return new ProviderError({
    ...base,
    kind: 'UNKNOWN',
    signal: code === null ? 'no structured signal' : `unrecognised code=${code}`,
  });
}

/** Classify a non-OK HTTP response. The body is never read for classification. */
export function classifyResponse(
  response: { status: number; headers?: { get(name: string): string | null } },
  context: ClassifyContext
): ProviderError {
  const now = context.now ?? new Date();
  const retryAfter =
    response.headers === undefined ? null : parseRetryAfter(response.headers.get('retry-after'), now);
  return new ProviderError({
    provider: context.provider,
    operation: context.operation,
    kind: kindForStatus(response.status),
    status: response.status,
    retryAfterSeconds: retryAfter,
    signal: `http status=${response.status}`,
  });
}

/**
 * The §32 gate, stated once so no call site has to remember it.
 *
 * An irreversible action whose outcome is AMBIGUOUS must be reconciled against the provider
 * before any retry. Returning `false` from here is what stops a timed-out send being sent twice.
 */
export function requiresReconciliation(error: ProviderError, irreversible: boolean): boolean {
  return irreversible && error.isAmbiguous;
}
