import { doc, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import type { Attribution } from '../domain/operatorAction';
import {
  ADDRESS_TYPES,
  LAWFUL_BASES,
  evaluateLawfulBasis,
  normaliseCountry,
  type AddressType,
  type BasisVerdict,
  type LawfulBasis,
} from '../domain/lawfulBasis';

/**
 * THE WRITER THE LAWFUL BASIS NEVER HAD.
 *
 * `server/domain/lawfulBasis.ts` decides whether a contact may be emailed. Until this file
 * existed, nothing could put a basis on a contact: `createContactSchema` refuses the consent
 * fields as mass assignment, `buildContactDocument` never wrote them, and the only other writer
 * copied an existing value between records during a merge. The decision had no input, so every
 * lead was permanently unmailable.
 *
 * FOUR RULES THIS FILE ENFORCES, EACH OF WHICH IS A WAY IT COULD GO WRONG
 * ----------------------------------------------------------------------
 * 1. IT NEVER TOUCHES A SUPPRESSION FLAG. `suppressed`, `unsubscribed`, `hardBounced` and
 *    `complained` are not in any patch this file builds. Recording a basis must never be a way
 *    to clear an unsubscribe, which is exactly what an overwrite-shaped create once was
 *    (`server/lib/identityStore.ts`). The gateway checks suppression BEFORE basis, so a
 *    resubscribed-looking record that still carries an unsubscribe stays blocked.
 *
 * 2. A REVOCATION IS NOT SILENTLY OVERWRITTEN. People do re-subscribe, so a revoked consent is
 *    not permanent — but restoring one is a deliberate act, not a side effect of re-posting a
 *    form. It requires an explicit acknowledgement and is recorded separately as a restoration.
 *
 * 3. RECORDING REQUIRES AN IDENTIFIED ACTOR, the same rule quote approval uses. A consent whose
 *    recorder cannot be named is a consent that cannot be defended.
 *
 * 4. THE CALLER IS TOLD WHETHER IT WORKED. The outcome carries the evaluated verdict, so an
 *    operator who records a basis and is still not able to send learns why immediately rather
 *    than at dispatch. Reporting "saved" for a record that remains unmailable would be the
 *    fabricated-success shape this repository keeps removing.
 *
 * Revocation deliberately does NOT require an identified actor. It moves in the safe direction,
 * and a control that refuses to stop something because it cannot name who asked is worse than
 * one that stops and records `unattributed`.
 */

export interface RecordBasisInput {
  readonly basis: LawfulBasis;
  /** Optional correction, applied in the same write so a basis and its jurisdiction agree. */
  readonly country?: string;
  readonly addressType?: AddressType;
  /** Required for CONSENT: where and when it was given, in a form someone could check. */
  readonly consentEvidence?: string;
  readonly consentSource?: string;
  /** Required for LEGITIMATE_INTEREST: which balancing assessment covers this contact. */
  readonly liaId?: string;
  /** ISO timestamp. Required before legitimate-interest outreach; see the domain module. */
  readonly article14NoticeSentAt?: string;
  /** Must be true to record consent over a previous revocation. */
  readonly acknowledgesRevocation?: boolean;
}

export type BasisWriteOutcome =
  | {
      readonly ok: true;
      readonly contactId: string;
      readonly basis: LawfulBasis;
      /** What the gate would now say about this contact. May still be a refusal. */
      readonly verdict: BasisVerdict;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'NOT_FOUND'
        | 'ATTRIBUTION_REQUIRED'
        | 'VALIDATION_ERROR'
        | 'REVOCATION_NOT_ACKNOWLEDGED'
        | 'STORE_UNAVAILABLE';
      readonly message: string;
    };

/** The identified actor, or null. Inline rather than a second copy of a private helper. */
function identifiedActor(by: Attribution): string | null {
  return by.kind === 'IDENTIFIED' ? by.actor : null;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function contactRef(orgId: string, contactId: string) {
  return doc(store, orgPath(orgId, 'contacts'), contactId);
}

/**
 * Record a lawful basis on a contact.
 *
 * The patch is built field by field rather than spread from the input, so a field this function
 * does not name cannot be written through it. That is the same defence `createContactSchema`
 * uses, applied at the second place a caller can reach a contact record.
 */
export async function recordLawfulBasis(
  orgId: string,
  contactId: string,
  input: RecordBasisInput,
  by: Attribution,
  now: Date = new Date()
): Promise<BasisWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }

  const actor = identifiedActor(by);
  if (actor === null) {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Recording a lawful basis needs an identified operator: ` +
        `${by.kind === 'UNATTRIBUTED' ? by.why : 'no actor on the credential'}.`,
    };
  }

  if (!(LAWFUL_BASES as readonly string[]).includes(input.basis)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Unrecognised basis ${JSON.stringify(input.basis)}; expected one of ${LAWFUL_BASES.join(', ')}.`,
    };
  }

  const evidence = trimmed(input.consentEvidence);
  if (input.basis === 'CONSENT' && evidence === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message:
        'Recording CONSENT requires evidence of where and when it was given. A consent that ' +
        'cannot be shown is one that cannot be defended.',
    };
  }

  const liaId = trimmed(input.liaId);
  if (input.basis === 'LEGITIMATE_INTEREST' && liaId === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message:
        'Recording LEGITIMATE_INTEREST requires the id of the balancing assessment that covers ' +
        'this contact.',
    };
  }

  const country = input.country === undefined ? undefined : normaliseCountry(input.country);
  if (input.country !== undefined && country === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `country must be an ISO-3166 alpha-2 code; received ${JSON.stringify(input.country)}.`,
    };
  }

  if (input.addressType !== undefined && !(ADDRESS_TYPES as readonly string[]).includes(input.addressType)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `addressType must be one of ${ADDRESS_TYPES.join(', ')}.`,
    };
  }

  const noticeSentAt = trimmed(input.article14NoticeSentAt);
  if (noticeSentAt !== null && Number.isNaN(Date.parse(noticeSentAt))) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `article14NoticeSentAt must be an ISO timestamp; received ${JSON.stringify(input.article14NoticeSentAt)}.`,
    };
  }

  const iso = now.toISOString();

  return runTransaction(store, async (tx) => {
    const snap = await tx.get(contactRef(orgId, contactId));
    if (!snap.exists()) {
      return {
        ok: false as const,
        code: 'NOT_FOUND' as const,
        message: `No contact ${contactId} in this organisation.`,
      };
    }
    const current = snap.data() as Record<string, unknown>;

    const revokedAt = trimmed(current.consentRevokedAt);
    if (revokedAt !== null && input.basis === 'CONSENT' && input.acknowledgesRevocation !== true) {
      return {
        ok: false as const,
        code: 'REVOCATION_NOT_ACKNOWLEDGED' as const,
        message:
          `Consent for this contact was revoked at ${revokedAt}. Recording consent over a ` +
          `revocation is a deliberate act: re-send with acknowledgesRevocation true, and only ` +
          `on fresh evidence that the person has opted in again. Note that this does not clear ` +
          `an unsubscribe, which is a separate and stronger signal.`,
      };
    }

    const restoring = revokedAt !== null && input.basis === 'CONSENT';

    // Built field by field. A field absent from this object cannot be written by this endpoint,
    // and no suppression flag appears anywhere in it.
    const patch: Record<string, unknown> = {
      lawfulBasis: input.basis,
      consentGiven: input.basis === 'CONSENT',
      consentEvidence: input.basis === 'CONSENT' ? evidence : (current.consentEvidence ?? null),
      consentSource: trimmed(input.consentSource) ?? (current.consentSource ?? null),
      consentRecordedAt: iso,
      consentRecordedBy: actor,
      liaId: liaId ?? (current.liaId ?? null),
      article14NoticeSentAt: noticeSentAt ?? (current.article14NoticeSentAt ?? null),
      version: (typeof current.version === 'number' ? current.version : 0) + 1,
      updatedAt: iso,
    };
    if (country !== undefined) patch.country = country;
    if (input.addressType !== undefined) patch.addressType = input.addressType;
    if (restoring) {
      patch.consentRevokedAt = null;
      patch.consentRestoredAt = iso;
      patch.consentRestoredBy = actor;
    }

    const next = { ...current, ...patch };
    tx.set(contactRef(orgId, contactId), next);

    return {
      ok: true as const,
      contactId,
      basis: input.basis,
      verdict: evaluateLawfulBasis(next),
    };
  });
}

/**
 * Revoke consent.
 *
 * Deliberately permissive about attribution: this moves in the safe direction, and refusing to
 * stop something because the caller cannot be named would be the wrong failure. The actor is
 * recorded as `unattributed` instead, which is visible in the record rather than hidden.
 *
 * It does not clear `lawfulBasis`. A contact may still be reachable on legitimate interest after
 * a consent is revoked, and pretending otherwise would overstate what a revocation means. What
 * it does is make the CONSENT basis unusable, which `evaluateLawfulBasis` enforces.
 */
export async function revokeConsent(
  orgId: string,
  contactId: string,
  by: Attribution,
  reason: string | null = null,
  now: Date = new Date()
): Promise<BasisWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const iso = now.toISOString();
  const actor = identifiedActor(by) ?? 'unattributed';

  return runTransaction(store, async (tx) => {
    const snap = await tx.get(contactRef(orgId, contactId));
    if (!snap.exists()) {
      return {
        ok: false as const,
        code: 'NOT_FOUND' as const,
        message: `No contact ${contactId} in this organisation.`,
      };
    }
    const current = snap.data() as Record<string, unknown>;
    const next = {
      ...current,
      consentGiven: false,
      consentRevokedAt: iso,
      consentRevokedBy: actor,
      consentRevokedReason: trimmed(reason),
      version: (typeof current.version === 'number' ? current.version : 0) + 1,
      updatedAt: iso,
    };
    tx.set(contactRef(orgId, contactId), next);
    return {
      ok: true as const,
      contactId,
      basis: (trimmed(current.lawfulBasis) as LawfulBasis) ?? 'CONSENT',
      verdict: evaluateLawfulBasis(next),
    };
  });
}
