import { neutralizeCsvValue } from '../../shared/lib/csvSafety';
import { tryContactDocId } from '../lib/identity';
import { timeZoneRejection } from '../../shared/domain/time';
import { ADDRESS_TYPES, normaliseCountry } from './lawfulBasis';

/**
 * WHAT A CANDIDATE CONTACT MUST SATISFY, WHATEVER PRODUCED IT (§11, §14, §18).
 *
 * A CSV row, a record from a paid discovery API and a block of text a scraper pulled off a
 * company's contact page are the same kind of thing: values from outside this system, proposed
 * as a contact. They are validated here, once.
 *
 * THE ALTERNATIVE IS THE FAILURE MODE
 * -----------------------------------
 * Each source validating its own input means three validators, and the interesting question is
 * which of them forgets something. The CSV importer neutralises formulas because it was written
 * with spreadsheets in mind; the provider adapter does not, because a JSON API "obviously" does
 * not carry spreadsheet formulas — and then a company name of `=HYPERLINK(...)` arrives from the
 * provider, is stored verbatim, and executes on the first operator who opens an export.
 *
 * THE ALLOWLIST IS THE MASS-ASSIGNMENT DEFENCE
 * --------------------------------------------
 * `CANDIDATE_FIELDS` is the complete set of fields a source may propose. Absent by design:
 * `consentGiven`, `suppressed`, `unsubscribed`, `hardBounced`, `complained`, `lawfulBasis`,
 * `organizationId`, `id`, `type`, `status`, `version`, `aiScore`, `consentRecordedBy`. The first
 * several are the suppression and consent state outreach safety depends on; the rest are
 * server-controlled. None of them is something an external source gets to assert.
 *
 * `lawfulBasis` is the one worth calling out. It is a decision an identified operator makes
 * about a batch, and a source that could nominate its own basis is a source that could talk its
 * way into being mailable.
 */

/** Per-cell length, matching the short-string bound the create schema already enforces. */
export const MAX_CANDIDATE_FIELD = 500;

/** Longest single value for the free-text note field. */
export const MAX_CANDIDATE_NOTES = 10_000;

export const CANDIDATE_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'name',
  'title',
  'phone',
  'linkedinUrl',
  'companyName',
  'companyWebsite',
  'industry',
  'country',
  'employeeCount',
  'timeZone',
  'notes',
  'addressType',
  'consentEvidence',
  'consentSource',
  'article14NoticeSentAt',
] as const;

export type CandidateField = (typeof CANDIDATE_FIELDS)[number];

export type CandidateRefusalCode =
  | 'NO_EMAIL'
  | 'UNUSABLE_EMAIL'
  | 'FIELD_TOO_LONG'
  | 'BAD_COUNTRY'
  | 'BAD_ADDRESS_TYPE'
  | 'BAD_TIME_ZONE'
  | 'BAD_NOTICE_TIMESTAMP';

export interface ValidCandidate {
  readonly email: string;
  /** The derived document id: the same derivation the create transaction will use. */
  readonly contactId: string;
  /** Neutralised, length-checked values for allowlisted fields only. */
  readonly fields: Readonly<Record<string, string>>;
}

export type CandidateOutcome =
  | { readonly ok: true; readonly candidate: ValidCandidate }
  | { readonly ok: false; readonly code: CandidateRefusalCode; readonly message: string };

/** Is this one of the fields a source may propose? */
export function isCandidateField(name: string): name is CandidateField {
  return (CANDIDATE_FIELDS as readonly string[]).includes(name);
}

function tooLong(field: string, value: string): boolean {
  return value.length > (field === 'notes' ? MAX_CANDIDATE_NOTES : MAX_CANDIDATE_FIELD);
}

/**
 * Validate a proposed contact.
 *
 * `raw` may contain anything; only allowlisted keys are read, and a key outside the allowlist is
 * IGNORED rather than refused — a source sending an extra field is usually a version skew, while
 * a field silently reaching the datastore is a security problem. Callers that want to report
 * what was ignored (the CSV importer does, because an unmapped column is usually an operator
 * mistake) compare the keys themselves.
 *
 * Every value is neutralised on the way IN. A formula stored verbatim survives to the next
 * export, and the ingest is the step that launders it into this system's own data.
 */
export function validateCandidate(raw: Readonly<Record<string, unknown>>): CandidateOutcome {
  const values: Record<string, string> = {};

  for (const field of CANDIDATE_FIELDS) {
    const supplied = raw[field];
    if (typeof supplied !== 'string') continue;
    const trimmed = supplied.trim();
    if (trimmed === '') continue;
    if (tooLong(field, trimmed)) {
      return {
        ok: false,
        code: 'FIELD_TOO_LONG',
        message:
          `${field} is ${trimmed.length} characters, above the limit for that field. Refused ` +
          `rather than truncated: half a value stored as if it were whole is worse than none.`,
      };
    }
    // The address is the identity key and is normalised by `tryContactDocId`; neutralising it
    // would change the key. Every other value is neutralised.
    values[field] = field === 'email' ? trimmed : neutralizeCsvValue(trimmed);
  }

  const email = values.email ?? '';
  if (email === '') {
    return {
      ok: false,
      code: 'NO_EMAIL',
      message: 'No email address, which is the identity key for a contact.',
    };
  }

  const contactId = tryContactDocId(email);
  if (contactId === null) {
    return {
      ok: false,
      code: 'UNUSABLE_EMAIL',
      message: `${JSON.stringify(email)} is not a usable email address.`,
    };
  }

  if (values.country !== undefined) {
    const country = normaliseCountry(values.country);
    if (country === null) {
      return {
        ok: false,
        code: 'BAD_COUNTRY',
        message:
          `country ${JSON.stringify(values.country)} is not an ISO-3166 alpha-2 code. Storing ` +
          `it would produce a record the outreach gate refuses for a reason nobody can read.`,
      };
    }
    values.country = country;
  }

  if (values.addressType !== undefined) {
    const addressType = values.addressType.toUpperCase();
    if (!(ADDRESS_TYPES as readonly string[]).includes(addressType)) {
      return {
        ok: false,
        code: 'BAD_ADDRESS_TYPE',
        message: `addressType must be one of ${ADDRESS_TYPES.join(', ')}; received ${JSON.stringify(values.addressType)}.`,
      };
    }
    values.addressType = addressType;
  }

  if (values.timeZone !== undefined && timeZoneRejection(values.timeZone) !== null) {
    return {
      ok: false,
      code: 'BAD_TIME_ZONE',
      message: `timeZone must be an IANA identifier such as Europe/London; received ${JSON.stringify(values.timeZone)}.`,
    };
  }

  if (values.article14NoticeSentAt !== undefined) {
    const at = Date.parse(values.article14NoticeSentAt);
    if (Number.isNaN(at)) {
      return {
        ok: false,
        code: 'BAD_NOTICE_TIMESTAMP',
        message:
          `article14NoticeSentAt ${JSON.stringify(values.article14NoticeSentAt)} is not a ` +
          `timestamp. This field records that a notice was ALREADY sent, so an unreadable ` +
          `value cannot be read as "sent".`,
      };
    }
    values.article14NoticeSentAt = new Date(at).toISOString();
  }

  return { ok: true, candidate: { email, contactId, fields: Object.freeze({ ...values }) } };
}
