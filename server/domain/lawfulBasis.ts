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
 *   LEGITIMATE_INTEREST  the B2B basis. Needs ALL of: a country whose regime permits it, an
 *                        address at an organisation rather than at a free-mail provider, a
 *                        STATED address type, a legitimate interests assessment on file, and
 *                        the data-subject notice already sent.
 *
 * THE TWO SEPARATE QUESTIONS ABOUT AN ADDRESS, WHICH ARE EASY TO CONFLATE
 * ----------------------------------------------------------------------
 * `addressType` asks whether the mailbox belongs to a named person (`jane@acme.example`) or to
 * a role (`info@acme.example`). That is a data-protection question about what category of
 * personal data the record holds, and BOTH answers are compatible with legitimate interest:
 * a named employee at a company is still a corporate subscriber. What refuses is an address
 * type nobody has stated, because unknown is not permission.
 *
 * Whether the recipient is a corporate subscriber at all is a DIFFERENT question, and it is
 * answered by the domain: `jane@gmail.com` is an individual subscriber however business-like
 * the message, and under PECR and its equivalents that is the case legitimate interest does
 * not reach. An earlier draft of this module conflated the two, documented the stricter rule
 * and implemented the looser one, so a bought list of free-mail addresses would have passed.
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

import { isFreeMailAddress } from '../lib/identity';
import { OUTREACH_REGIMES, type CountryRule, type OutreachRegime } from './lawfulBasisSources';
import type { AssessmentVerdict } from './lia';

/** The bases this system recognises. Anything else is not a basis. */
export const LAWFUL_BASES = ['CONSENT', 'LEGITIMATE_INTEREST'] as const;
export type LawfulBasis = (typeof LAWFUL_BASES)[number];

/** Whether an address belongs to a named person or to a role such as `info@`. */
export const ADDRESS_TYPES = ['PERSONAL', 'ROLE'] as const;
export type AddressType = (typeof ADDRESS_TYPES)[number];

/**
 * THE COUNTRY TABLE MOVED, AND GREW A REQUIREMENT.
 *
 * `OUTREACH_REGIMES` now lives in `./lawfulBasisSources`, where each row carries the instruments
 * and provisions it is derived from, the specific questions a reviewer still has to answer, and
 * a `review` field that is null until a qualified person signs it off. It is re-exported here so
 * every existing importer is unaffected, and so the one table remains the one table.
 *
 * The move is not tidying. Previously a country was a regime plus a sentence of prose, and the
 * instruction to have the table checked lived in a comment — which meant a seventh country could
 * be added with no source at all and nothing would notice. The row type now requires at least
 * one citation, so adding a country is mechanically an act of citing something.
 */
export type { CountryRule, OutreachRegime };
export { OUTREACH_REGIMES };

export type BasisRefusalCode =
  | 'NO_BASIS'
  | 'UNKNOWN_BASIS'
  | 'COUNTRY_UNKNOWN'
  | 'COUNTRY_NOT_REVIEWED'
  | 'COUNTRY_NOT_LEGALLY_REVIEWED'
  | 'CONSENT_NOT_RECORDED'
  | 'CONSENT_REVOKED'
  | 'CONSENT_UNEVIDENCED'
  | 'CONSENT_UNATTRIBUTED'
  | 'LI_NOT_AVAILABLE_IN_COUNTRY'
  | 'LI_ADDRESS_TYPE_UNKNOWN'
  | 'LI_INDIVIDUAL_SUBSCRIBER'
  | 'LI_NO_ASSESSMENT'
  | 'LI_ASSESSMENT_NOT_RESOLVED'
  | 'LI_ASSESSMENT_INVALID'
  | 'LI_ASSESSMENT_MISMATCH'
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
  /** The recipient address. Read only to tell a corporate subscriber from an individual one. */
  readonly email?: unknown;
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
 * Options that make the gate stricter. There is no option that makes it looser, deliberately.
 */
export interface BasisOptions {
  /**
   * Refuse any country whose row in the table has not been signed off by a qualified person.
   *
   * DEFAULT FALSE, AND THE DEFAULT IS THE UNSAFE-LOOKING ONE, SO HERE IS THE ARGUMENT.
   *
   * Every row is unreviewed today. If this defaulted true, nothing in this system would be
   * mailable at all — no preview would work, no test fixture would evaluate, and the entire
   * lead pipeline would be dark until a solicitor had been paid. That is not a safety property,
   * it is a development freeze, and the pressure it creates is to fill `review` in with
   * something plausible to get moving. A control people are motivated to defeat is worse than
   * one placed where the motivation runs the other way.
   *
   * So the check bites at the only place it matters: `ActionGateway.executeEmailSend` passes
   * `requireReviewedRegime: isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')`. Development and
   * preview are unaffected; the moment real sending is turned on, an unreviewed country stops.
   * Turning the flag on therefore cannot quietly begin mailing people under a rule nobody
   * checked, which is the actual failure this guards against.
   */
  readonly requireReviewedRegime?: boolean;

  /**
   * Refuse unless `liaId` resolves to a signed, unwithdrawn, unexpired assessment covering this
   * contact's country — rather than merely being a non-empty string.
   *
   * WHAT THIS REPLACES. The check below used to be `nonEmptyString(facts.liaId) !== null`, with
   * a comment reading "the assessment is what makes the basis defensible". Typing `x` satisfied
   * it. That is the exact shape of defect this file exists to remove, sitting inside the file
   * that removes it.
   *
   * Resolution needs a datastore read, and this function is pure and stays pure — so the CALLER
   * resolves the id (`resolveAssessmentForContact`) and passes the verdict in. The default is
   * off for the same reason `requireReviewedRegime` defaults off: making it unconditional would
   * mean every preview, fixture and test had to seed an assessment, and the pressure would be
   * to weaken the check rather than to write one.
   */
  readonly requireSignedAssessment?: boolean;

  /**
   * The resolved assessment, when the caller has looked it up.
   *
   * Absent with `requireSignedAssessment` set is itself a refusal — `LI_ASSESSMENT_NOT_RESOLVED`
   * — and not a pass. A caller that asks for the strict check and then forgets to do the lookup
   * has a bug, and the failure mode of treating that as permission is the one that matters.
   */
  readonly assessment?: AssessmentVerdict;
}

/**
 * May this contact lawfully be sent commercial email?
 *
 * Suppression is NOT checked here. It is checked before this, and it outranks any basis: an
 * unsubscribe beats a consent, because the later statement is the operative one. Keeping the
 * two separate means neither can be mistaken for the other.
 */
export function evaluateLawfulBasis(facts: BasisFacts, options: BasisOptions = {}): BasisVerdict {
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

  // The row exists. Has anyone qualified actually checked it? Applies to BOTH bases, because
  // an unreviewed row is unreviewed about consent too: what form of consent Germany requires
  // and what a US footer must contain are exactly the sort of particular this catches.
  if (options.requireReviewedRegime === true && entry.review === null) {
    return {
      ok: false,
      code: 'COUNTRY_NOT_LEGALLY_REVIEWED',
      message:
        `The rule recorded for ${country} has not been reviewed by a qualified person. It reads: ` +
        `"${entry.note}" — derived from ${entry.sources.length} cited provision(s) and carrying ` +
        `${entry.openQuestions.length} unanswered question(s). Real sending is on, so an ` +
        `unchecked rule refuses. Record the sign-off in server/domain/lawfulBasisSources.ts; ` +
        `docs/production/legal-review-pack.md is the same material written for the reviewer.`,
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
      code: 'LI_ADDRESS_TYPE_UNKNOWN',
      message:
        `This record does not say whether the address belongs to a named person or to a role ` +
        `such as info@ (addressType=${JSON.stringify(facts.addressType)}). Both are compatible ` +
        `with legitimate interest, but an unstated one is not: the category of personal data ` +
        `being processed has to be known before it can be justified.`,
    };
  }

  // A free-mail address is an individual subscriber, whatever the message is about, and that
  // is the case the B2B basis does not reach. `null` — an address too broken to classify —
  // refuses too, because "I cannot tell" is not "it is a company".
  const freeMail = isFreeMailAddress(facts.email);
  if (freeMail !== false) {
    return {
      ok: false,
      code: 'LI_INDIVIDUAL_SUBSCRIBER',
      message:
        freeMail === null
          ? `Cannot tell whether ${JSON.stringify(facts.email)} is an organisation address, so ` +
            `legitimate interest cannot be established. A usable address is a precondition, not ` +
            `a detail.`
          : `${JSON.stringify(facts.email)} is at a free-mail provider, which makes the ` +
            `recipient an individual subscriber rather than a corporate one. Legitimate ` +
            `interest does not reach that case; consent does.`,
    };
  }

  const liaId = nonEmptyString(facts.liaId);
  if (liaId === null) {
    return {
      ok: false,
      code: 'LI_NO_ASSESSMENT',
      message:
        'Legitimate interest requires a balancing assessment on file, and none is referenced ' +
        'by this contact. The assessment is what makes the basis defensible.',
    };
  }

  // The id names something. Does that something exist, and does it say what it needs to say?
  if (options.requireSignedAssessment === true) {
    const resolved = options.assessment;
    if (resolved === undefined) {
      return {
        ok: false,
        code: 'LI_ASSESSMENT_NOT_RESOLVED',
        message:
          `A signed assessment was required for this decision and none was looked up. The ` +
          `caller asked for the strict check and did not resolve ${JSON.stringify(liaId)}, ` +
          `which is a caller bug; an unresolved assessment is refused rather than assumed.`,
      };
    }
    if (!resolved.ok) {
      return {
        ok: false,
        code: 'LI_ASSESSMENT_INVALID',
        message: `${resolved.code}: ${resolved.message}`,
      };
    }
    if (resolved.id !== liaId) {
      // Belt and braces. If these disagree, the verdict in hand describes a different document
      // from the one this contact cites, and acting on it would attribute one assessment's
      // signature to another assessment's text.
      return {
        ok: false,
        code: 'LI_ASSESSMENT_MISMATCH',
        message:
          `This contact cites assessment ${JSON.stringify(liaId)} but the resolved verdict is ` +
          `for ${JSON.stringify(resolved.id)}. Refusing rather than crediting one document with ` +
          `another document's signature.`,
      };
    }
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
