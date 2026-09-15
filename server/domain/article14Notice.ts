/**
 * THE ARTICLE 14 NOTICE, AS A DOCUMENT THIS SYSTEM CAN ACTUALLY PRODUCE (§14, §18).
 *
 * WHAT WAS MISSING
 * ----------------
 * `recordArticle14Notice` recorded that a notice had been sent. Nothing sent one. The field it
 * wrote is a precondition for legitimate-interest outreach, so the operator's route to a
 * mailable contact was to assert the notice had gone out — and the system believed them. That is
 * a compliance control whose enforcement is an honour system, which is the same thing as no
 * control, dressed up.
 *
 * WHY IT CANNOT GO THROUGH THE ORDINARY SEND PATH
 * -----------------------------------------------
 * `executeEmailSend` refuses a contact whose notice has not been sent. Routing the notice
 * through it would be a circular dependency with a legal shape: the message that creates the
 * lawful basis cannot require the lawful basis it creates. So the notice is a SEPARATE gateway
 * action — `PRIVACY_NOTICE_SEND` — with a different and deliberately chosen set of checks.
 *
 * WHAT IT STILL CHECKS, AND WHAT IT DELIBERATELY DOES NOT
 * ------------------------------------------------------
 *   SUPPRESSION        still refuses. An unsubscribe, a complaint or a hard bounce means stop
 *                      sending to this address, and a legal obligation to inform does not
 *                      override somebody having told us to go away — the obligation is then met
 *                      by other means, or by deleting the record, which is usually the honest
 *                      answer for a lead nobody may contact.
 *   LAWFUL BASIS       NOT checked. This message is the thing that establishes it.
 *   CAMPAIGN SAFETY    NOT checked. Frequency caps, quiet hours and daily recipient limits are
 *                      controls on marketing volume. The notice is not marketing, is sent once
 *                      per person ever, and is time-bound — the obligation runs to roughly a
 *                      month — so a quiet-hours deferral would trade a real deadline against a
 *                      courtesy. Being explicit about this because silently skipping guards is
 *                      how the guards stop meaning anything.
 *
 * WHAT ARTICLE 14 ACTUALLY REQUIRES, AND WHERE EACH PIECE COMES FROM
 * -----------------------------------------------------------------
 * The notice is assembled, not written. Every required element has exactly one source, and a
 * missing source is a refusal rather than a blank line:
 *
 *   controller identity and contact details   organisation settings
 *   data protection officer                   organisation settings (explicitly "none" if none)
 *   purposes and legal basis                  the signed balancing assessment
 *   legitimate interests pursued              the assessment's purpose limb
 *   categories of personal data               the assessment's dataCategories
 *   THE SOURCE THE DATA CAME FROM             the contact's own provenance record
 *   retention period                          organisation settings
 *   the person's rights                       fixed text, because they are fixed
 *   right to complain to a supervisory body   organisation settings
 *   how to object                             the assessment's objectionRoute
 *
 * The source line is the one that matters most and the one a generic template always gets wrong:
 * Article 14(2)(f) asks which source the data came from, and this system knows — per contact,
 * from the ingest that created it. Telling someone "from publicly available sources" when the
 * record came from a purchased list would be a false statement in a compliance notice.
 *
 * EVERY INTERPOLATED VALUE IS UNTRUSTED (§18)
 * -------------------------------------------
 * The contact's name, company and source evidence came from a CSV, a vendor API or somebody
 * else's web page. They are escaped on the way into the HTML body. A scraped company name of
 * `<img src=x onerror=...>` is a real thing to receive, and this is the one place in the
 * repository that builds HTML out of externally supplied strings.
 */

import type { AssessmentVerdict, LiaRecord } from './lia';

/** The controller details a notice cannot be written without. */
export const CONTROLLER_FIELDS = [
  'controllerName',
  'controllerPostalAddress',
  'controllerContactEmail',
  'privacyPolicyUrl',
  'retentionPolicy',
  'supervisoryAuthority',
  'dpoContact',
] as const;

export type ControllerField = (typeof CONTROLLER_FIELDS)[number];

export interface ControllerIdentity {
  readonly controllerName: string;
  /** A real postal address. CAN-SPAM requires one in the footer and Article 14 asks for it. */
  readonly controllerPostalAddress: string;
  readonly controllerContactEmail: string;
  readonly privacyPolicyUrl: string;
  /** How long records are kept and on what trigger they are deleted. */
  readonly retentionPolicy: string;
  /** Which authority the person may complain to, and how. */
  readonly supervisoryAuthority: string;
  /**
   * The data protection officer's contact details.
   *
   * REQUIRED AS A FIELD, even for an organisation with no DPO — which must write something like
   * "No data protection officer is appointed." Absent and "none appointed" are different facts
   * and only one of them is a configured system; leaving it optional would let a notice ship
   * with the DPO line silently missing, which is the failure mode this list exists to prevent.
   */
  readonly dpoContact: string;
}

export type ControllerRefusalCode = 'CONTROLLER_NOT_CONFIGURED' | 'CONTROLLER_FIELD_TOO_LONG';

export const MAX_CONTROLLER_FIELD = 2_000;

export type ControllerOutcome =
  | { readonly ok: true; readonly controller: ControllerIdentity }
  | {
      readonly ok: false;
      readonly code: ControllerRefusalCode;
      readonly message: string;
      /** Exactly which fields are missing, so the operator fixes it in one pass. */
      readonly missing: readonly ControllerField[];
    };

/**
 * Read the controller identity out of an organisation's settings document.
 *
 * Refuses with the complete list of what is missing rather than the first gap. An operator who
 * has to discover seven required fields one round trip at a time will fill them with
 * placeholders by the third.
 */
export function readControllerIdentity(settings: Readonly<Record<string, unknown>>): ControllerOutcome {
  const values: Record<string, string> = {};
  const missing: ControllerField[] = [];

  for (const field of CONTROLLER_FIELDS) {
    const raw = settings[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      missing.push(field);
      continue;
    }
    if (value.length > MAX_CONTROLLER_FIELD) {
      return {
        ok: false,
        code: 'CONTROLLER_FIELD_TOO_LONG',
        message: `${field} is ${value.length} characters, above the ${MAX_CONTROLLER_FIELD} limit.`,
        missing: [],
      };
    }
    values[field] = value;
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'CONTROLLER_NOT_CONFIGURED',
      message:
        `The Article 14 notice cannot be written because this organisation has not configured ` +
        `${missing.join(', ')}. Each is an element the notice is required to contain, and ` +
        `sending one with the line missing would be worse than not sending it: it would create ` +
        `a record that the obligation had been discharged when it had not.`,
      missing,
    };
  }

  return { ok: true, controller: values as unknown as ControllerIdentity };
}

/** What the notice says about a specific person's record. */
export interface NoticeSubject {
  readonly email: string;
  /** May be empty. The notice addresses the person by name only when it has one. */
  readonly name: string;
  readonly companyName: string;
  /** `IMPORT`, `PROVIDER:<name>`, `SCRAPE:<domain>`, `MANUAL`. */
  readonly source: string;
  /** Enough for the person to recognise where we got it: a file, a query, a URL. */
  readonly sourceEvidence: string;
  readonly sourceCollectedAt: string;
}

export type NoticeRefusalCode =
  | 'NO_RECIPIENT'
  | 'NO_PROVENANCE'
  | 'ASSESSMENT_NOT_VALID';

export interface BuiltNotice {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** A stable digest of what was sent, stored as the evidence of what the person received. */
  readonly summary: string;
}

export type NoticeOutcome =
  | { readonly ok: true; readonly notice: BuiltNotice }
  | { readonly ok: false; readonly code: NoticeRefusalCode; readonly message: string };

/**
 * Escape a string for interpolation into HTML.
 *
 * Every value that reaches the HTML body of a notice came from outside this system. The five
 * characters below are the complete set that matters for text nodes and for quoted attribute
 * values, and nothing here is ever interpolated outside those two positions — no URLs built
 * from contact data, no inline script, no style. Keeping that true is why the template below is
 * one function rather than a set of fragments callers assemble.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Describe where the data came from, in terms the recipient can act on. */
function sourceSentence(subject: NoticeSubject): string {
  const source = subject.source.trim();
  const evidence = subject.sourceEvidence.trim();
  if (source.startsWith('SCRAPE:')) {
    return (
      `We collected it from a publicly accessible web page: ${evidence || source.slice(7)}. ` +
      `It was not obtained from you directly.`
    );
  }
  if (source.startsWith('PROVIDER:')) {
    return (
      `We obtained it from a third-party data provider, ${source.slice(9)}, in the search ` +
      `recorded as "${evidence}". It was not obtained from you directly.`
    );
  }
  if (source === 'IMPORT') {
    return (
      `We obtained it from a list imported into our system, recorded as "${evidence}". It was ` +
      `not obtained from you directly.`
    );
  }
  if (source === 'MANUAL') {
    return (
      `A member of our team entered it, recording the origin as "${evidence}". It was not ` +
      `obtained from you through a form or a sign-up.`
    );
  }
  return `We obtained it from ${source}, recorded as "${evidence}". It was not obtained from you directly.`;
}

const RIGHTS_LINES: readonly string[] = [
  'ask us for a copy of the personal data we hold about you',
  'ask us to correct it if it is wrong, or to complete it if it is incomplete',
  'ask us to delete it',
  'ask us to restrict how we use it',
  'object to our using it — and where we use it for direct marketing, we must stop on request, with no balancing and no exceptions',
  'ask us to transfer it to you or to someone else in a machine-readable form',
];

/**
 * Build the notice for one person.
 *
 * Takes a RESOLVED assessment verdict rather than an id, so this cannot be called for an
 * unsigned or withdrawn assessment: the notice states the legal basis on which we intend to
 * process someone's data, and stating a basis that does not hold would be a false statement in
 * the document whose whole purpose is to be accurate.
 */
export function buildArticle14Notice(input: {
  readonly controller: ControllerIdentity;
  readonly subject: NoticeSubject;
  readonly assessment: AssessmentVerdict;
  readonly lia: Pick<LiaRecord, 'purpose' | 'dataCategories' | 'objectionRoute'>;
}): NoticeOutcome {
  const { controller, subject, assessment, lia } = input;

  if (typeof subject.email !== 'string' || subject.email.trim() === '') {
    return { ok: false, code: 'NO_RECIPIENT', message: 'The notice has no recipient address.' };
  }
  if (!assessment.ok) {
    return {
      ok: false,
      code: 'ASSESSMENT_NOT_VALID',
      message:
        `The notice states the legal basis we intend to rely on, and this contact's assessment ` +
        `is not usable (${assessment.code}: ${assessment.message}). Sending a notice that ` +
        `asserts a basis which does not hold would make the compliance record itself untrue.`,
    };
  }
  if (subject.source.trim() === '' || subject.sourceEvidence.trim() === '') {
    return {
      ok: false,
      code: 'NO_PROVENANCE',
      message:
        'Article 14(2)(f) requires the notice to say which source the data came from, and this ' +
        'record does not carry one. A notice that omits the source, or fills it in with a ' +
        'plausible guess, defeats the point of sending it.',
    };
  }

  const greeting = subject.name.trim() === '' ? 'Hello,' : `Hello ${subject.name.trim()},`;
  const company = subject.companyName.trim();
  const categories = lia.dataCategories.join(', ');

  const paragraphs: string[] = [
    greeting,
    `We are writing to tell you that ${controller.controllerName} holds some personal data about you, because the law requires us to tell you when we obtain your data from somewhere other than you. This is not a marketing message and you do not need to do anything in response to it.`,
    `WHERE WE GOT YOUR DETAILS. ${sourceSentence(subject)}${company === '' ? '' : ` Our record associates you with ${company}.`} We obtained it on ${subject.sourceCollectedAt}.`,
    `WHAT WE HOLD. ${categories}.`,
    `WHY WE HOLD IT, AND ON WHAT BASIS. We process it for our legitimate interests under Article 6(1)(f) of the UK GDPR and its equivalents, specifically: ${lia.purpose} We have carried out and signed a balancing assessment covering this, recorded as ${assessment.id} and signed on ${assessment.signedAt.slice(0, 10)}. We can provide it on request.`,
    `HOW LONG WE KEEP IT. ${controller.retentionPolicy}`,
    `WHO ELSE SEES IT. Our own staff, and the service providers who operate our email and data systems on our behalf. We do not sell it.`,
    `YOUR RIGHTS. You can ${RIGHTS_LINES.join('; ')}.`,
    `HOW TO OBJECT OR ASK US TO DELETE IT. ${lia.objectionRoute} You can also simply reply to this email and tell us to stop; we will remove you and not contact you again.`,
    `IF YOU ARE NOT HAPPY WITH US. ${controller.supervisoryAuthority}`,
    `OUR DETAILS. ${controller.controllerName}, ${controller.controllerPostalAddress}. Email ${controller.controllerContactEmail}. Data protection contact: ${controller.dpoContact}. Our privacy notice is at ${controller.privacyPolicyUrl}.`,
  ];

  const text = paragraphs.join('\n\n');
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.6;color:#111">` +
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    `</div>`;

  return {
    ok: true,
    notice: {
      subject: `How ${controller.controllerName} obtained your contact details, and your rights`,
      text,
      html,
      summary:
        `Article 14 notice sent to ${subject.email} citing source ${subject.source} ` +
        `(${subject.sourceEvidence}) and assessment ${assessment.id}.`,
    },
  };
}
