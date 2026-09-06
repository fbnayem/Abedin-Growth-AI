/**
 * S28 — bounce, DSN and automated-mail classification, before any reply.
 *
 * WHAT WAS WRONG
 * --------------
 * Nothing classified inbound mail at all. A repo-wide search for `automationClassification`
 * found a column and no writer; the only bounce-address check in the system lived inside
 * `isSuppressed`, whose sole caller is the independent auditor, which is stubbed to a constant
 * on the live path. So a mailer-daemon delivery failure ran the entire pipeline: it was stored
 * as an inbound message, given to the model as something the prospect had written, and answered.
 *
 * The MIME walk made it worse and did so silently. A DSN is `multipart/report` with a
 * `message/delivery-status` part; that part matched none of the old walk's three branches and
 * was dropped, while the human-readable preamble ("Your message could not be delivered") WAS
 * captured. A bounce therefore arrived looking exactly like an ordinary reply, with the only
 * machine-readable evidence removed on the way in.
 *
 * WHAT THE ANSWER IS BASED ON
 * ---------------------------
 * Headers and MIME structure. Never subject prose. The repository already carries a guardrail
 * against classifying provider errors by substring, for a reason recorded in `providerError.ts`:
 * a customer who writes the trigger word in their own text steers the decision. "Subject starts
 * with 'Out of Office'" is the same defect wearing different clothes — and it does not survive
 * a language change, while `Auto-Submitted: auto-replied` does.
 *
 * THE DEFAULT
 * -----------
 * `NO_AUTOMATION_MARKERS` is the only class that permits a reply, and it is a statement about
 * evidence rather than a conclusion: it says we found no marker, not that a human typed this.
 * Every other class refuses. A new class added to the union therefore refuses by default, which
 * is the direction §14 requires.
 */

import type { HeaderBag, ParsedBody } from '../lib/mime';

export const AUTOMATION_CLASSES = [
  'BOUNCE',
  'OUT_OF_OFFICE',
  'AUTO_REPLY',
  'AUTO_GENERATED',
  'MAILING_LIST',
  'NO_AUTOMATION_MARKERS',
] as const;

export type AutomationClass = (typeof AUTOMATION_CLASSES)[number];

export interface AutomationVerdict {
  classification: AutomationClass;
  /** Only NO_AUTOMATION_MARKERS permits an autonomous reply. */
  replyPermitted: boolean;
  /** The structural signals that decided it, for the message record and the operator. */
  signals: string[];
  /** Human-readable, one line. */
  reason: string;
  /**
   * A permanent delivery failure. The recipient must be suppressed: continuing to mail an
   * address the provider has told us does not exist is what destroys a sending reputation.
   */
  permanentFailure: boolean;
  /** The address that failed, when the DSN names one. */
  failedRecipient: string | null;
  /** The RFC 3463 status code, e.g. `5.1.1`, when present. */
  dsnStatus: string | null;
}

/**
 * Local-parts that identify a sender as a machine.
 *
 * A list of addresses is not prose-matching: these are role addresses defined by convention and
 * by RFC 2142, matched on the whole local-part rather than as a substring — `noreply@x` matches
 * and `nore.ply.notes@x` does not.
 */
const MACHINE_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'no-reply',
  'noreply',
  'donotreply',
  'do-not-reply',
  'bounce',
  'bounces',
  'notification',
  'notifications',
  'automailer',
  'auto-reply',
  'autoreply',
]);

/** `"Name" <a@b.com>` -> `a@b.com`. Returns null when there is no address to find. */
export function addressOf(headerValue: string | null | undefined): string | null {
  if (typeof headerValue !== 'string') return null;
  const angled = /<([^>]*)>/.exec(headerValue);
  const candidate = (angled === null ? headerValue : angled[1]).trim().toLowerCase();
  if (candidate === '') return null;
  if (!candidate.includes('@')) return null;
  return candidate;
}

function localPartOf(address: string | null): string | null {
  if (address === null) return null;
  const at = address.lastIndexOf('@');
  return at <= 0 ? null : address.slice(0, at);
}

/** RFC 3463 status codes: the class digit is the whole question. 5 is permanent. */
export function isPermanentDsnStatus(status: string | null): boolean {
  return typeof status === 'string' && /^5\./.test(status.trim());
}

/**
 * RFC 3464 recipient fields carry an ADDRESS TYPE first: `Final-Recipient: rfc822; a@b.com`.
 *
 * Feeding that to `addressOf` yields `rfc822; a@b.com`, which contains an `@` and therefore
 * looks like a valid address — so the suppression record would name a recipient that does not
 * exist, and a human reading the bounce reason would see a mangled address. Caught by a test
 * asserting the extracted recipient rather than merely that one was extracted.
 */
export function dsnRecipientAddress(field: string | null | undefined): string | null {
  if (typeof field !== 'string') return null;
  const semicolon = field.indexOf(';');
  const withoutType = semicolon >= 0 ? field.slice(semicolon + 1) : field;
  return addressOf(withoutType);
}

export interface ClassifyInput {
  headers: Pick<HeaderBag, 'get' | 'raw' | 'all' | 'has'>;
  body: Pick<ParsedBody, 'deliveryStatus'>;
}

export function classifyAutomation(input: ClassifyInput): AutomationVerdict {
  const { headers, body } = input;
  const signals: string[] = [];

  // ---- delivery status, the strongest evidence there is ---------------------
  const statusEntry =
    body.deliveryStatus.find((f) => typeof f['status'] === 'string') ?? body.deliveryStatus[0] ?? null;
  const dsnStatus = statusEntry === null ? null : (statusEntry['status'] ?? null);
  const dsnAction = statusEntry === null ? null : (statusEntry['action'] ?? null);
  const dsnRecipient =
    statusEntry === null
      ? null
      : dsnRecipientAddress(statusEntry['final-recipient'] ?? statusEntry['original-recipient'] ?? null);

  const contentType = headers.raw('content-type') ?? '';
  const isReport = /multipart\/report/i.test(contentType);
  const reportsDeliveryStatus = /report-type\s*=\s*"?delivery-status"?/i.test(contentType);

  if (body.deliveryStatus.length > 0) signals.push('message/delivery-status part present');
  if (isReport) signals.push('Content-Type: multipart/report');
  if (reportsDeliveryStatus) signals.push('report-type=delivery-status');
  if (headers.has('x-failed-recipients')) signals.push('X-Failed-Recipients');

  // An empty Return-Path is the null reverse-path of RFC 5321 §4.5.5: this message is itself a
  // notification, and replying to it is how mail loops are made.
  const returnPath = headers.raw('return-path');
  const nullReturnPath = returnPath !== null && returnPath.replace(/\s/g, '') === '<>';
  if (nullReturnPath) signals.push('null Return-Path');

  const fromAddress = addressOf(headers.raw('from'));
  const fromLocal = localPartOf(fromAddress);
  const machineSender = fromLocal !== null && MACHINE_LOCAL_PARTS.has(fromLocal);
  if (machineSender) signals.push(`role sender local-part "${fromLocal}"`);

  const isBounce =
    body.deliveryStatus.length > 0 ||
    (isReport && reportsDeliveryStatus) ||
    headers.has('x-failed-recipients') ||
    (nullReturnPath && machineSender);

  if (isBounce) {
    const permanent =
      isPermanentDsnStatus(dsnStatus) ||
      (dsnStatus === null && dsnAction !== null && dsnAction.toLowerCase() === 'failed');
    const failedRecipient =
      dsnRecipient ?? addressOf(headers.raw('x-failed-recipients')) ?? null;
    return {
      classification: 'BOUNCE',
      replyPermitted: false,
      signals,
      reason:
        `Delivery status notification${dsnStatus === null ? '' : ` (${dsnStatus})`}` +
        `${failedRecipient === null ? '' : ` for ${failedRecipient}`}. ` +
        'Replying to a bounce sends mail to a mailbox that has already refused it.',
      permanentFailure: permanent,
      failedRecipient,
      dsnStatus,
    };
  }

  // ---- mailing lists --------------------------------------------------------
  if (headers.has('list-id') || headers.has('list-unsubscribe') || headers.has('list-post')) {
    signals.push('List-* headers');
    return {
      classification: 'MAILING_LIST',
      replyPermitted: false,
      signals,
      reason: 'Message carries List-* headers. A reply would go to a distribution, not a person.',
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  // ---- out of office --------------------------------------------------------
  // Exchange stamps this on automatic replies generated by an inbox rule. It is the one
  // STRUCTURAL out-of-office signal that exists; there is no header that says "vacation", and
  // matching the subject for one would be prose-classification in a different language's
  // absence.
  if (headers.has('x-ms-exchange-inbox-rules-loop')) {
    signals.push('X-MS-Exchange-Inbox-Rules-Loop');
    return {
      classification: 'OUT_OF_OFFICE',
      replyPermitted: false,
      signals,
      reason: 'Automatic reply generated by an inbox rule. Replying starts a loop.',
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  // ---- RFC 3834 -------------------------------------------------------------
  const autoSubmitted = headers.raw('auto-submitted');
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== 'no') {
    const value = autoSubmitted.trim().toLowerCase();
    signals.push(`Auto-Submitted: ${value}`);
    const replied = value.startsWith('auto-replied');
    return {
      classification: replied ? 'AUTO_REPLY' : 'AUTO_GENERATED',
      replyPermitted: false,
      signals,
      reason: `RFC 3834 Auto-Submitted: ${value}. Replying to it is explicitly forbidden by that RFC.`,
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  if (headers.has('x-autoreply') || headers.has('x-autorespond') || headers.has('x-autoresponder')) {
    signals.push('X-Autoreply/X-Autorespond');
    return {
      classification: 'AUTO_REPLY',
      replyPermitted: false,
      signals,
      reason: 'Message declares itself an automatic response.',
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  const precedence = (headers.raw('precedence') ?? '').trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk' || precedence === 'auto_reply') {
    signals.push(`Precedence: ${precedence}`);
    return {
      classification: 'AUTO_GENERATED',
      replyPermitted: false,
      signals,
      reason: `Precedence: ${precedence} marks this as bulk or automated mail.`,
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  if (machineSender || nullReturnPath) {
    return {
      classification: 'AUTO_GENERATED',
      replyPermitted: false,
      signals,
      reason:
        'Sent from a role address that does not accept replies, or with a null return path. ' +
        'A reply would be delivered to nobody, or bounce.',
      permanentFailure: false,
      failedRecipient: null,
      dsnStatus: null,
    };
  }

  return {
    classification: 'NO_AUTOMATION_MARKERS',
    replyPermitted: true,
    signals: [],
    reason:
      'No automation marker found. This states what was not present; it is not a claim that a ' +
      'person typed it.',
    permanentFailure: false,
    failedRecipient: null,
    dsnStatus: null,
  };
}

/**
 * The reply gate, stated once.
 *
 * An equality against the one permitting class, not a list of forbidden ones — a class added to
 * the union later refuses by default instead of inheriting permission.
 */
export function mayReplyTo(classification: AutomationClass): boolean {
  return classification === 'NO_AUTOMATION_MARKERS';
}
