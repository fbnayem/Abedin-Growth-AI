/**
 * S32 / S16 — the identity an irreversible send must carry so it can be asked about afterwards.
 *
 * WHAT WAS MISSING
 * ----------------
 * §32 says a provider timeout is not a failure: the message may have been delivered and only
 * the response lost, so an irreversible action must be RECONCILED against the provider before
 * any retry. The taxonomy for that landed in P1.11 — `providerError.ts` classifies TIMEOUT,
 * CONNECTION_FAILED, PROVIDER_UNAVAILABLE and UNKNOWN as AMBIGUOUS and exposes
 * `requiresReconciliation`. Nothing acted on it. The worker dead-lettered every ambiguous job
 * and the comment said "requires an operator or the reconciliation worker to resolve"; there
 * was no reconciliation worker.
 *
 * The reason there was none is here rather than there. **Reconciliation needs a question you
 * can ask.** The outbound message carried no identity of our choosing:
 *
 *     const messageParts = [ `To: ${opts.to}`, `Subject: ${opts.subject}`, ... ];
 *
 * — no Message-ID, so after a timeout the only available query was "is there a message to this
 * address with this subject?", which cannot distinguish the send that just timed out from the
 * one that succeeded last week. An unanswerable question is why the branch stayed a comment.
 *
 * THE RULE
 * --------
 * Every outbound message carries a Message-ID DERIVED FROM ITS IDEMPOTENCY KEY. Same job, same
 * id, on every attempt and in every process. That makes `rfc822msgid:<id>` an exact provider-side
 * search for "did this specific send happen", which is the only question reconciliation asks.
 *
 * A send that cannot be given such an id is refused rather than sent, because an irreversible
 * action whose outcome can never afterwards be established is the thing §32 exists to prevent.
 *
 * SECOND DEFECT, SAME LINES (S16)
 * -------------------------------
 * Those headers were built by raw interpolation of values that come from a customer's own
 * email. `Subject: ${opts.subject}` with a CR-LF in the subject is header injection: the
 * remainder becomes a new header, and `Bcc:` is a header. The reply subject is derived from the
 * inbound subject, so the injecting text arrives from outside the system — §18, exactly: what
 * arrives as data must never become structure.
 */

import { createHash } from 'crypto';

/** A header value that would change the structure of the message rather than its content. */
export class UnsafeHeaderValueError extends Error {
  readonly headerName: string;
  constructor(headerName: string, reason: string) {
    super(`Refusing to build header "${headerName}": ${reason}`);
    this.name = 'UnsafeHeaderValueError';
    this.headerName = headerName;
  }
}

/** Raised when a send cannot be made reconcilable. Never downgraded to a warning. */
export class UnreconcilableSendError extends Error {
  constructor(reason: string) {
    super(`Refusing to send: ${reason}`);
    this.name = 'UnreconcilableSendError';
  }
}

/**
 * CR, LF and NUL are the three characters that end a header field. Rejecting rather than
 * stripping is deliberate: silently deleting part of a subject line changes what the customer
 * sees with no record, and a subject containing a bare CR is not a subject anyone typed — it is
 * either an attack or a bug, and both deserve to be loud.
 */
const HEADER_STRUCTURE_CHARACTERS = /[\r\n\u0000]/;

export function assertSafeHeaderValue(headerName: string, value: string): string {
  if (typeof value !== 'string') {
    throw new UnsafeHeaderValueError(headerName, `value is ${typeof value}, not a string`);
  }
  if (HEADER_STRUCTURE_CHARACTERS.test(value)) {
    throw new UnsafeHeaderValueError(
      headerName,
      'it contains CR, LF or NUL, which would terminate the header and let the remainder ' +
        'become headers of its own (Bcc: among them)'
    );
  }
  return value;
}

/** Build one header line, or refuse. */
export function headerLine(name: string, value: string): string {
  return `${name}: ${assertSafeHeaderValue(name, value)}`;
}

/**
 * The domain half of the Message-ID. RFC 5322 wants a globally unique right-hand side; using
 * the sending domain is the convention and is also what makes the id recognisably ours in a
 * customer's mailbox.
 */
const DOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidMessageIdDomain(domain: unknown): domain is string {
  return typeof domain === 'string' && DOMAIN_PATTERN.test(domain.toLowerCase());
}

/**
 * The deterministic id.
 *
 * Hashed rather than used raw: an idempotency key can contain an email address or a
 * conversation id, and a Message-ID travels in the clear to the recipient and every relay in
 * between. The hash keeps the id stable — which is the whole mechanism — without publishing
 * what it was derived from.
 *
 * @throws {UnreconcilableSendError} when no stable identity is available. A send with no
 * reconcilable identity is refused, not sent with a random id: a random id is stable within one
 * attempt and different on the retry, so it would answer "did this send happen" with "no" every
 * time and licence exactly the duplicate §32 forbids.
 */
export function outboundMessageId(idempotencyKey: unknown, domain: unknown): string {
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    throw new UnreconcilableSendError(
      'no idempotency key, so no stable Message-ID can be derived and the send could never ' +
        'afterwards be reconciled against the provider (§32)'
    );
  }
  if (!isValidMessageIdDomain(domain)) {
    throw new UnreconcilableSendError(
      `outbound Message-ID domain is not a valid domain name (${JSON.stringify(domain)}). ` +
        'Set OUTBOUND_MESSAGE_ID_DOMAIN to the sending domain.'
    );
  }
  const digest = createHash('sha256').update(idempotencyKey.trim(), 'utf8').digest('hex').slice(0, 40);
  return `<ag.${digest}@${String(domain).toLowerCase()}>`;
}

/** `<a@b>` -> `a@b`. Gmail's `rfc822msgid:` operator takes the id without the angle brackets. */
export function bareMessageId(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Shape check for an id we are about to search on, so a malformed one is not sent to a provider. */
export function isWellFormedMessageId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bare = bareMessageId(value);
  if (bare === '' || HEADER_STRUCTURE_CHARACTERS.test(bare)) return false;
  const at = bare.indexOf('@');
  return at > 0 && at < bare.length - 1 && !bare.includes(' ');
}
