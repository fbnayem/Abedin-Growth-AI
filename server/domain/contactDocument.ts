import { normalizeEmailKey } from '../lib/emailKey';
import type { AddressSourceKind } from './addressSource';
import type { AddressType, LawfulBasis } from './lawfulBasis';

/**
 * THE SHAPE OF A CONTACT RECORD, IN ONE PLACE.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The three create endpoints used to build their document inline, and the import path was
 * about to become a fourth builder. Four builders is four opinions about which fields a new
 * contact has, and the field they would disagree about first is the one that matters: a
 * builder that writes `consentGiven: false` and one that leaves it absent produce records the
 * outreach gate treats differently, and nothing would have noticed until a send was refused
 * for a reason nobody could reproduce.
 *
 * So the shape is stated once. Callers supply the parts they are entitled to supply.
 *
 * WHAT A CALLER MAY NOT SUPPLY
 * ----------------------------
 * `suppressed`, `unsubscribed`, `hardBounced`, `complained` and `suppressionReason` are not
 * parameters of this function and are not in its output. A new record has no suppression
 * state, and a record that already exists is never rebuilt through here — the create is a
 * transaction that refuses when the document is present (`createContactIfAbsent`), precisely
 * so that re-posting a contact cannot reset an unsubscribe.
 *
 * `consentGiven` is derived from the basis, never passed. It is true when and only when the
 * basis is CONSENT, which keeps the flag and the basis from ever disagreeing.
 */

/** The caller-supplied part: exactly the fields an operator or a file may state. */
export interface ContactFieldInput {
  readonly email: string;
  readonly name?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly title?: string;
  readonly phone?: string;
  readonly linkedinUrl?: string;
  readonly companyName?: string;
  readonly companyWebsite?: string;
  readonly industry?: string;
  readonly country?: string;
  readonly employeeCount?: string;
  readonly notes?: string;
  readonly timeZone?: string;
}

/**
 * Where a record came from.
 *
 * Mandatory rather than optional. A contact whose origin is unknown cannot be given an
 * Article 14 notice, because that notice has to say where the data came from, and a record
 * that cannot carry the notice cannot be mailed on legitimate interest.
 */
export interface ContactProvenance {
  /** `MANUAL`, `IMPORT`, `PROVIDER:<name>` or `SCRAPE:<domain>`. */
  readonly source: string;
  /** Enough for a person to find the origin again: a file name, a query, a URL. */
  readonly sourceEvidence: string;
  /** When the record was obtained, which is not always when it was stored. */
  readonly sourceCollectedAt: string;
  /** Groups the records that arrived together, so one import can be reviewed as a unit. */
  readonly importBatchId?: string;
}

/**
 * WHERE THE ADDRESS CAME FROM — a sibling of `ContactProvenance`, and deliberately not part of it.
 *
 * `ContactProvenance` answers "how did we find this PERSON". This answers "how did we get their
 * ADDRESS", and the two are different acts with different expectations attached. A person found on
 * LinkedIn whose address was published by their employer and one whose address was bought share
 * every field of the first object and differ entirely in this one.
 *
 * WHY IT IS A SEPARATE TYPE AND NOT THREE MORE FIELDS ON THE FIRST.
 * A prospect has no email address at all — that is what the collection is for. Adding these to
 * `ContactProvenance` would have meant either making them optional, which is how a required check
 * becomes a skipped one, or inventing a NO_ADDRESS member of the vocabulary, which is a word for
 * "not applicable" that later becomes a default. Splitting the type states the domain fact
 * instead: a prospect has person-provenance and no address-provenance, and `createProspects`
 * therefore does not take one.
 */
export interface AddressProvenance {
  /** From the closed list in `./addressSource`. Decides which assessments can cover this record. */
  readonly addressSourceKind: AddressSourceKind;
  /** Enough for a person to check the claim: the page, the provider, the convention inferred. */
  readonly addressSourceEvidence: string;
  /** When the ADDRESS was obtained, which is not when the person was identified. */
  readonly addressCollectedAt: string;
}

/** The lawful basis a create may record, if any. Absent means the record is not yet mailable. */
export interface ContactBasisInput {
  readonly basis: LawfulBasis;
  readonly addressType?: AddressType;
  readonly consentEvidence?: string;
  readonly consentSource?: string;
  readonly liaId?: string;
  readonly article14NoticeSentAt?: string;
  readonly recordedBy: string;
}

export interface BuildContactOptions {
  readonly id: string;
  readonly organizationId: string;
  readonly type: 'LEAD' | 'INVESTOR' | 'PARTNER';
  readonly status: string;
  readonly now: Date;
  readonly provenance: ContactProvenance;
  /** Required. See `AddressProvenance` for why it is not folded into `provenance`. */
  readonly address: AddressProvenance;
  readonly basis?: ContactBasisInput;
}

function orNull(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value.trim();
}

/** A new contact document, built field by field from values the caller is entitled to set. */
export function buildContactDocument(
  input: ContactFieldInput,
  options: BuildContactOptions
): Record<string, unknown> {
  const iso = options.now.toISOString();
  const derivedName =
    orNull(input.name) ?? orNull([input.firstName, input.lastName].filter(Boolean).join(' ')) ?? '';

  const document: Record<string, unknown> = {
    id: options.id,
    organizationId: options.organizationId,
    type: options.type,
    status: options.status,
    // Server-controlled. Never taken from a request or a file.
    version: 0,
    createdAt: iso,
    updatedAt: iso,

    name: derivedName,
    firstName: orNull(input.firstName),
    lastName: orNull(input.lastName),
    email: input.email,
    emailKey: normalizeEmailKey(input.email),
    title: orNull(input.title),
    phone: orNull(input.phone),
    linkedinUrl: orNull(input.linkedinUrl),
    companyName: orNull(input.companyName),
    companyWebsite: orNull(input.companyWebsite),
    industry: orNull(input.industry),
    country: orNull(input.country),
    employeeCount: orNull(input.employeeCount),
    notes: orNull(input.notes),
    timeZone: orNull(input.timeZone),

    source: options.provenance.source,
    sourceEvidence: options.provenance.sourceEvidence,
    sourceCollectedAt: options.provenance.sourceCollectedAt,
    importBatchId: options.provenance.importBatchId ?? null,

    // The address half of the same question. Stored as first-class fields rather than appended to
    // `sourceEvidence`, because the gate reads the kind and prose cannot be read by a gate.
    addressSourceKind: options.address.addressSourceKind,
    addressSourceEvidence: options.address.addressSourceEvidence,
    addressCollectedAt: options.address.addressCollectedAt,
  };

  const basis = options.basis;
  if (basis !== undefined) {
    document.lawfulBasis = basis.basis;
    // Derived, never passed. The flag and the basis cannot disagree if only one of them is an
    // input, and the gate reads both.
    document.consentGiven = basis.basis === 'CONSENT';
    document.consentEvidence = orNull(basis.consentEvidence);
    document.consentSource = orNull(basis.consentSource);
    document.consentRecordedAt = iso;
    document.consentRecordedBy = basis.recordedBy;
    document.liaId = orNull(basis.liaId);
    document.article14NoticeSentAt = orNull(basis.article14NoticeSentAt);
    if (basis.addressType !== undefined) document.addressType = basis.addressType;
  }

  return document;
}
