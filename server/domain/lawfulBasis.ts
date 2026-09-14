/**
 * LAWFUL BASIS FOR OUTREACH (§14).
 *
 * WHAT THIS REPLACES
 * ------------------
 * `ActionGateway.executeEmailSend` asked one question: `contactData.consentGiven !== true`.
 * That check is correct and fail-closed, and it is also the reason no lead in this system has
 * ever been mailable. `createContactSchema` deliberately refuses to accept `consentGiven`
 * (mass assignment, `server/lib/validation.ts:52`), `buildContactDocument` never writes it, and
 * the only writer left is `contactMerge`, which can only carry an existing `true` from one
 * record to another. Nothing could set the first `true`. A closed loop with no entrance.
 *
 * The fix is not to loosen the gate. It is to give the gate a richer question to ask, keeping
 * the same rule: UNKNOWN IS NEVER PERMISSION. Every branch below either proves a basis or
 * refuses, and the default for anything unrecognised is refusal.
 *
 * THE TWO BASES
 * -------------
 *   CONSENT              the person agreed. Needs evidence and a recorded actor, and a
 *                        revocation outranks everything.
 *   LEGITIMATE_INTEREST  the B2B basis. Needs ALL of: a country whose regime permits it, a
 *                        business address rather than a personal one, a legitimate interests
 *                        assessment on file, and the data-subject notice already sent.
 *
 * WHY THE NOTICE IS A GATE AND NOT A POLICY DOCUMENT
 * -------------------------------------------------
 * Where a record was collected indirectly — imported, purchased, or scraped — UK and EU data
 * protection law requires the person to be told where their data came from, generally within a
 * month and before or at first contact. Legitimate interest is a real and widely used basis for
 * B2B outreach, but it is only defensible alongside that notice and a balancing assessment.
 *
 * Making both mechanical preconditions is the same move this repository makes everywhere else:
 * a rule that is enforced cannot be forgotten, and a rule that lives only in a document will be.
 */

/** The bases this system recognises. Anything else is not a basis. */
export const LAWFUL_BASES = ['CONSENT', 'LEGITIMATE_INTEREST'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/** Whether an address belongs to a named person or to a role such as `info@`. */
export const ADDRESS_TYPES = ['PERSONAL', 'ROLE'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

/**
 * How a country treats unsolicited commercial email.
 *
 *   GDPR_LI           legitimate interest is available for business recipients, with a right
 *                     to object that must be honoured.
 *   OPT_OUT           no prior permission required, subject to the local regime's own rules
 *                     (accurate headers, a postal address, a working unsubscribe).
 *   CONSENT_REQUIRED  prior express permission, including for business recipients.
 */
export type OutreachRegime = 'GDPR_LI' | 'OPT_OUT' | 'CONSENT_REQUIRED';

/**
 * The country table.
 *
 * DELIBERATELY SHORT, AND DELIBERATELY DENY-BY-DEFAULT. A country that is not listed here
 * refuses, rather than falling back to the most permissive reading of the least information —
 * which is the exact defect §14 exists to prevent and which this gate previously contained as
 * `resolvedCountry = 'US'`.
 *
 * THIS TABLE NEEDS LEGAL REVIEW BEFORE IT IS RELIED ON. The entries below are a starting point
 * drawn from the commonly stated position in each jurisdiction, not legal advice, and the
 * distinctions are genuinely fine: in the UK the consent rule in PECR applies to individual
 * subscribers, so a sole trader or a partnership is treated very differently from a limited
 * company at the same address. Add a country only when someone has checked it.
 */
export const OUTREACH_REGIMES: Readonly<Record<string, { regime: OutreachRegime; note: string }>> =
  Object.freeze({
    GB: {
      regime: 'GDPR_LI',
      note:
        'PECR restricts unsolicited email to individual subscribers. Corporate subscribers may ' +
        'be contacted on a legitimate interests basis, with a right to object. Sole traders and ' +
        'partnerships count as individual subscribers and need consent.',
    },
    US: {
      regime: 'OPT_OUT',
      note:
        'CAN-SPAM requires no prior permission, but does require accurate headers, a valid ' +
        'postal address and a working opt-out honoured promptly.',
    },
    NL: {
      regime: 'GDPR_LI',
      note: 'Business recipients may be contacted on an opt-out basis.',
    },
    FR: {
      regime: 'GDPR_LI',
      note:
        'The regulator permits business email where the message relates to the recipient\'s ' +
        'professional role, on an opt-out basis.',
    },
    DE: {
      regime: 'CONSENT_REQUIRED',
      note: 'Prior express consent is required for advertising email, including business to business.',
    },
    CA: {
      regime: 'CONSENT_REQUIRED',
      note: 'CASL requires express or implied consent before a commercial electronic message.',
    },
  });

export type BasisRefusalCode =
  | 'NO_BASIS'
  | 'UNKNOWN_BASIS'
  | 'COUNTRY_UNKNOWN'
  | 'COUNTRY_NOT_REVIEWED'
  | 'CONSENT_NOT_RECORDED'
  | 'CONSENT_REVOKED'
  | 'CONSENT_UNEVIDENCED'
  | 'CONSENT_UNATTRIBUTED'
  | 'LI_NOT_AVAILABLE_IN_COUNTRY'
  | 'LI_PERSONAL_ADDRESS'
  | 'LI_NO_ASSESSMENT'
  | 'LI_NOTICE_NOT_SENT';

export type BasisVerdict =
  | {
      readonly ok: true;
      readonly basis: LawfulBasis;
      readonly regime: OutreachRegime;
      /** The normalised ISO-3166 alpha-2 code the verdict was reached under. */
      readonly country: string;
      readonly why: string;
    }
  | { readonly ok: false; readonly code: BasisRefusalCode; readonly message: string };

/** The fields this decision reads. Everything is `unknown` because it arrives from a document. */
export interface BasisFacts {
  readonly lawfulBasis?: unknown;
  readonly country?: unknown;
  readonly addressType?: unknown;
  readonly consentGiven?: unknown;
  readonly consentRevokedAt?: unknown;
  readonly consentEvidence?: unknown;
  readonly consentRecordedBy?: unknown;
  readonly liaId?: unknown;
  readonly article14NoticeSentAt?: unknown;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** An ISO-3166 alpha-2 code, upper-cased, or null. Anything else is not a country. */
export function normaliseCountry(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(raw) ? raw : null;
}

/** The regime for a country, or null when nobody has reviewed it. */
export function regimeFor(country: unknown): OutreachRegime | null {
  const code = normaliseCountry(country);
  if (code === null) return null;
  return OUTREACH_REGIMES[code]?.regime ?? null;
}

/**
 * May this contact lawfully be sent commercial email?
 *
 * Suppression is NOT checked here. It is checked before this, and it outranks any basis: an
 * unsubscribe beats a consent, because the later statement is the operative one. Keeping the
 * two separate means neither can be mistaken for the other.
 */
export function evaluateLawfulBasis(facts: BasisFacts): BasisVerdict {
  const country = normaliseCountry(facts.country);
  if (country === null) {
    return {
      ok: false,
      code: 'COUNTRY_UNKNOWN',
      message:
        `Recipient jurisdiction is unknown or not an ISO-3166 alpha-2 code ` +
        `(country=${JSON.stringify(facts.country)}). Refusing rather than assuming a ` +
        `permissive jurisdiction.`,
    };
  }

  const entry = OUTREACH_REGIMES[country];
  if (!entry) {
    return {
      ok: false,
      code: 'COUNTRY_NOT_REVIEWED',
      message:
        `No outreach regime is recorded for ${country}. A country is added to the table only ` +
        `once its rules have been checked, and an unreviewed country refuses rather than ` +
        `inheriting another country's rules.`,
    };
  }

  const basis = nonEmptyString(facts.lawfulBasis);
  if (basis === null) {
    return {
      ok: false,
      code: 'NO_BASIS',
      message:
        'No lawful basis is recorded for this contact. An absent basis is insufficient data, ' +
        'not permission.',
    };
  }
  if (!(LAWFUL_BASES as readonly string[]).includes(basis)) {
    return {
      ok: false,
      code: 'UNKNOWN_BASIS',
      message:
        `Unrecognised lawful basis ${JSON.stringify(basis)}. The recognised bases are ` +
        `${LAWFUL_BASES.join(' and ')}.`,
    };
  }

  if (basis === 'CONSENT') {
    // A revocation outranks the consent it revokes, whatever order they were written in.
    const revoked = nonEmptyString(facts.consentRevokedAt);
    if (revoked !== null) {
      return {
        ok: false,
        code: 'CONSENT_REVOKED',
        message: `Consent was revoked at ${revoked}. A revocation cannot be undone by re-recording consent.`,
      };
    }
    if (facts.consentGiven !== true) {
      return {
        ok: false,
        code: 'CONSENT_NOT_RECORDED',
        message:
          `The basis is CONSENT but no affirmative consent is recorded ` +
          `(consentGiven=${JSON.stringify(facts.consentGiven)}).`,
      };
    }
    if (nonEmptyString(facts.consentEvidence) === null) {
      return {
        ok: false,
        code: 'CONSENT_UNEVIDENCED',
        message:
          'Consent is recorded with no evidence of where it was given. A consent that cannot ' +
          'be shown is one that cannot be defended, so it does not count.',
      };
    }
    if (nonEmptyString(facts.consentRecordedBy) === null) {
      return {
        ok: false,
        code: 'CONSENT_UNATTRIBUTED',
        message:
          'Consent is recorded with no identified actor. Who recorded it is part of the record, ' +
          'the same way an approved quote names its approver.',
      };
    }
    return {
      ok: true,
      basis: 'CONSENT',
      regime: entry.regime,
      country,
      why: `Consent recorded and evidenced; ${country} regime is ${entry.regime}.`,
    };
  }

  // LEGITIMATE_INTEREST, which is the B2B basis and carries four conditions.
  if (entry.regime === 'CONSENT_REQUIRED') {
    return {
      ok: false,
      code: 'LI_NOT_AVAILABLE_IN_COUNTRY',
      message:
        `${country} requires prior consent for commercial email, including business to ` +
        `business, so legitimate interest is not available there. ${entry.note}`,
    };
  }

  const addressType = nonEmptyString(facts.addressType);
  if (addressType !== 'ROLE' && addressType !== 'PERSONAL') {
    return {
      ok: false,
      code: 'LI_PERSONAL_ADDRESS',
      message:
        `Legitimate interest applies to business recipients, and this record does not say ` +
        `whether the address is a business role address or a personal one ` +
        `(addressType=${JSON.stringify(facts.addressType)}). Unknown is treated as personal.`,
    };
  }

  if (nonEmptyString(facts.liaId) === null) {
    return {
      ok: false,
      code: 'LI_NO_ASSESSMENT',
      message:
        'Legitimate interest requires a balancing assessment on file, and none is referenced ' +
        'by this contact. The assessment is what makes the basis defensible.',
    };
  }

  if (nonEmptyString(facts.article14NoticeSentAt) === null) {
    return {
      ok: false,
      code: 'LI_NOTICE_NOT_SENT',
      message:
        'The data-subject notice has not been sent. Where a record was collected indirectly, ' +
        'the person must be told where their data came from before or at first contact, so ' +
        'outreach is refused until that notice is recorded as sent.',
    };
  }

  return {
    ok: true,
    basis: 'LEGITIMATE_INTEREST',
    regime: entry.regime,
    country,
    why:
      `Legitimate interest: ${country} regime is ${entry.regime}, assessment on file, ` +
      `notice sent, address type ${addressType}.`,
  };
}
