import { collection, doc, getDoc, getDocs, orderBy, query, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import type { Attribution } from '../domain/operatorAction';
import {
  LIA_SUBSTANTIVE_FIELDS,
  assessmentVerdict,
  defaultReviewDue,
  validateLiaDraft,
  type AssessmentVerdict,
  type LiaRecord,
} from '../domain/lia';

/**
 * THE WRITE PATH FOR A BALANCING ASSESSMENT.
 *
 * `server/domain/lia.ts` decides what an assessment means. This file is the only thing that
 * creates, signs or withdraws one, and it enforces the three properties that make a signature
 * worth anything.
 *
 * 1. SIGNING IS A ONE-WAY DOOR. Once signed, the substantive fields cannot be edited — not by
 *    this service and not through any route that reaches it. A signature is a claim about a
 *    specific text, and a text that can change afterwards makes the signature evidence of
 *    nothing. The remedy for a wrong assessment is to withdraw it and write another, which is
 *    what the real-world act looks like too.
 *
 * 2. SIGNING NEEDS A NAMED PERSON. Not "the system", not the organisation — a person, from the
 *    credential, the same rule quote approval and lawful-basis recording already use. The signer
 *    is the one taking responsibility for the balancing test, so an unattributable signature is
 *    a contradiction.
 *
 * 3. WITHDRAWAL IS CHEAP AND DOES NOT NEED A REPLACEMENT. It moves in the safe direction. A
 *    control that will not let you stop relying on something until you have written its
 *    successor is a control people work around.
 *
 * WHY THE DRAFTER MAY ALSO BE THE SIGNER
 * --------------------------------------
 * Segregating them would be better and it would not survive contact with a two-person company:
 * the workaround is a second account, which produces a record that is worse than an honest one.
 * Both names are stored — `createdBy` and `signedBy` — so an auditor can see when they are the
 * same person and weigh that themselves. The system records the fact rather than pretending to
 * prevent it.
 */

export type LiaWriteRefusal =
  | 'STORE_UNAVAILABLE'
  | 'ATTRIBUTION_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'ALREADY_SIGNED'
  | 'ALREADY_WITHDRAWN'
  | 'NOT_SIGNED';

export type LiaWriteOutcome =
  | { readonly ok: true; readonly record: LiaRecord }
  | { readonly ok: false; readonly code: LiaWriteRefusal; readonly message: string };

function identifiedActor(by: Attribution): string | null {
  return by.kind === 'IDENTIFIED' ? by.actor : null;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function attributionRefusal(by: Attribution, what: string): { ok: false; code: 'ATTRIBUTION_REQUIRED'; message: string } {
  return {
    ok: false,
    code: 'ATTRIBUTION_REQUIRED',
    message:
      `${what} needs an identified operator: ` +
      `${by.kind === 'UNATTRIBUTED' ? by.why : 'no actor on the credential'}.`,
  };
}

function liaRef(orgId: string, id: string) {
  return doc(store, orgPath(orgId, 'legitimateInterestAssessments'), id);
}

/**
 * A readable id that says what it is and when it was made.
 *
 * Derived from the moment of creation plus a counter-free random suffix, and deliberately NOT
 * from the title: two assessments with the same title are two assessments, and an id that
 * collided would silently make one of them the other.
 */
function newLiaId(now: Date): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Math.random().toString(36).slice(2, 10);
  return `lia_${stamp}_${suffix}`;
}

/** Create an assessment. It is a draft until somebody signs it, and a draft supports nothing. */
export async function createAssessment(
  orgId: string,
  raw: Readonly<Record<string, unknown>>,
  by: Attribution,
  now: Date = new Date()
): Promise<LiaWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const actor = identifiedActor(by);
  if (actor === null) return attributionRefusal(by, 'Writing a balancing assessment');

  const validated = validateLiaDraft(raw);
  if (!validated.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${validated.code}: ${validated.message}` };
  }

  const iso = now.toISOString();
  const record: LiaRecord = {
    ...validated.draft,
    id: newLiaId(now),
    organizationId: orgId,
    createdAt: iso,
    createdBy: actor,
    signedBy: null,
    signedAt: null,
    reviewDueAt: null,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawnReason: null,
    version: 1,
  };

  return runTransaction(store, async (tx) => {
    tx.set(liaRef(orgId, record.id), record as unknown as Record<string, unknown>);
    return { ok: true as const, record };
  });
}

/**
 * Amend an unsigned assessment.
 *
 * Refuses outright once signed. That refusal is the invariant this service exists for, so it is
 * checked inside the transaction against the stored record rather than against anything the
 * caller passed — a caller who has just read an unsigned record and a signature that lands in
 * between are the same race, and the read-modify-write has to see it.
 */
export async function amendAssessment(
  orgId: string,
  id: string,
  raw: Readonly<Record<string, unknown>>,
  by: Attribution,
  now: Date = new Date()
): Promise<LiaWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const actor = identifiedActor(by);
  if (actor === null) return attributionRefusal(by, 'Amending a balancing assessment');

  const validated = validateLiaDraft(raw);
  if (!validated.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${validated.code}: ${validated.message}` };
  }

  const iso = now.toISOString();
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(liaRef(orgId, id));
    if (!snap.exists()) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: `No assessment ${id} in this organisation.` };
    }
    const current = snap.data() as unknown as LiaRecord;
    if (trimmed(current.signedAt) !== null) {
      return {
        ok: false as const,
        code: 'ALREADY_SIGNED' as const,
        message:
          `Assessment ${id} was signed by ${current.signedBy} at ${current.signedAt} and cannot ` +
          `be edited. A signature is a claim about a specific text; if the text can change ` +
          `afterwards it is evidence of nothing. Withdraw it and write its replacement.`,
      };
    }
    if (trimmed(current.withdrawnAt) !== null) {
      return {
        ok: false as const,
        code: 'ALREADY_WITHDRAWN' as const,
        message: `Assessment ${id} was withdrawn at ${current.withdrawnAt}; write a new one instead.`,
      };
    }

    const next: LiaRecord = {
      ...current,
      ...validated.draft,
      amendedAt: iso,
      amendedBy: actor,
      version: (typeof current.version === 'number' ? current.version : 0) + 1,
    };
    tx.set(liaRef(orgId, id), next as unknown as Record<string, unknown>);
    return { ok: true as const, record: next };
  });
}

/**
 * Sign an assessment.
 *
 * `reviewDueAt` is the signer's, with a twelve-month default when they do not give one. It is
 * not a field the assessment carries from its draft: the review date is part of the act of
 * signing, and a drafter who could set it could write an assessment that never expires.
 */
export async function signAssessment(
  orgId: string,
  id: string,
  by: Attribution,
  options: { readonly reviewDueAt?: string } = {},
  now: Date = new Date()
): Promise<LiaWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const actor = identifiedActor(by);
  if (actor === null) return attributionRefusal(by, 'Signing a balancing assessment');

  const supplied = trimmed(options.reviewDueAt);
  if (supplied !== null && Number.isNaN(Date.parse(supplied))) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `reviewDueAt must be an ISO timestamp; received ${JSON.stringify(options.reviewDueAt)}.`,
    };
  }
  if (supplied !== null && Date.parse(supplied) <= now.getTime()) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message:
        `reviewDueAt ${supplied} is not in the future. An assessment that is due for review ` +
        `before it is signed supports nothing, and recording one would look like a signature.`,
    };
  }

  const iso = now.toISOString();
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(liaRef(orgId, id));
    if (!snap.exists()) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: `No assessment ${id} in this organisation.` };
    }
    const current = snap.data() as unknown as LiaRecord;
    if (trimmed(current.withdrawnAt) !== null) {
      return {
        ok: false as const,
        code: 'ALREADY_WITHDRAWN' as const,
        message:
          `Assessment ${id} was withdrawn at ${current.withdrawnAt}. Signing a withdrawn ` +
          `assessment would resurrect a document somebody deliberately stopped relying on.`,
      };
    }
    if (trimmed(current.signedAt) !== null) {
      return {
        ok: false as const,
        code: 'ALREADY_SIGNED' as const,
        message: `Assessment ${id} was already signed by ${current.signedBy} at ${current.signedAt}.`,
      };
    }

    const next: LiaRecord = {
      ...current,
      signedBy: actor,
      signedAt: iso,
      reviewDueAt: supplied ?? defaultReviewDue(now),
      version: (typeof current.version === 'number' ? current.version : 0) + 1,
    };
    tx.set(liaRef(orgId, id), next as unknown as Record<string, unknown>);
    return { ok: true as const, record: next };
  });
}

/**
 * Withdraw an assessment.
 *
 * Deliberately permissive about attribution, for the same reason `revokeConsent` is: this stops
 * something rather than starting it, and a control that refuses to let you stop because it
 * cannot name who asked is the wrong failure. The actor is recorded as `unattributed`, which is
 * visible in the record rather than hidden.
 *
 * Every contact citing this assessment becomes unmailable the moment it is written, with no
 * second write anywhere: the gate resolves the assessment at send time, so withdrawal takes
 * effect by being true rather than by being propagated.
 */
export async function withdrawAssessment(
  orgId: string,
  id: string,
  reason: string,
  by: Attribution,
  now: Date = new Date()
): Promise<LiaWriteOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const detail = trimmed(reason);
  if (detail === null) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message:
        'Withdrawing an assessment needs a reason. Anyone who later finds contacts citing it ' +
        'will want to know whether the basis was wrong or merely out of date.',
    };
  }

  const actor = identifiedActor(by) ?? 'unattributed';
  const iso = now.toISOString();
  return runTransaction(store, async (tx) => {
    const snap = await tx.get(liaRef(orgId, id));
    if (!snap.exists()) {
      return { ok: false as const, code: 'NOT_FOUND' as const, message: `No assessment ${id} in this organisation.` };
    }
    const current = snap.data() as unknown as LiaRecord;
    if (trimmed(current.withdrawnAt) !== null) {
      // Idempotent rather than an error: the first withdrawal is the operative one and its date
      // is the one that matters, so a repeat returns the record unchanged.
      return { ok: true as const, record: current };
    }
    const next: LiaRecord = {
      ...current,
      withdrawnAt: iso,
      withdrawnBy: actor,
      withdrawnReason: detail,
      version: (typeof current.version === 'number' ? current.version : 0) + 1,
    };
    tx.set(liaRef(orgId, id), next as unknown as Record<string, unknown>);
    return { ok: true as const, record: next };
  });
}

/** Read one assessment, or null. Tenant-scoped by the path, like every other read here. */
export async function getAssessment(orgId: string, id: string): Promise<LiaRecord | null> {
  if (!store) return null;
  const trimmedId = trimmed(id);
  if (trimmedId === null) return null;
  const snap = await getDoc(liaRef(orgId, trimmedId));
  if (!snap.exists()) return null;
  return snap.data() as unknown as LiaRecord;
}

/** Every assessment in this organisation, newest first. */
export async function listAssessments(orgId: string): Promise<LiaRecord[]> {
  if (!store) return [];
  const snap = await getDocs(
    query(collection(store, orgPath(orgId, 'legitimateInterestAssessments')), orderBy('createdAt', 'desc'))
  );
  return snap.docs.map((d) => d.data() as unknown as LiaRecord);
}

/**
 * Resolve the assessment a contact cites, and say what it supports.
 *
 * This is the function the gateway calls before a send. It returns a verdict rather than a
 * record, so the caller cannot accidentally treat "found" as "valid" — which is the mistake the
 * old free-text `liaId` check institutionalised.
 *
 * THE CONTEXT IS AN OBJECT AND NOT TWO POSITIONAL STRINGS, ON PURPOSE. `country` and `source`
 * are both strings, both describe the contact, and sit next to each other; passed positionally,
 * transposing them is a silent error that produces a confident wrong verdict — `GB` would be
 * read as a route and `SCRAPE:x` as a jurisdiction, and both would refuse for reasons naming the
 * wrong field. A named object cannot be transposed.
 */
export async function resolveAssessmentForContact(
  orgId: string,
  liaId: unknown,
  context: { readonly country: string; readonly source: unknown; readonly now?: Date }
): Promise<AssessmentVerdict> {
  const id = trimmed(liaId);
  if (id === null) {
    return {
      ok: false,
      code: 'LIA_NOT_FOUND',
      message: 'This contact cites no balancing assessment, so there is nothing to resolve.',
    };
  }
  return assessmentVerdict(await getAssessment(orgId, id), {
    country: context.country,
    source: context.source,
    now: context.now ?? new Date(),
  });
}

/**
 * The fields a signature freezes, re-exported so the invariant suite can assert that `amend`
 * covers all of them without importing the domain module twice.
 */
export { LIA_SUBSTANTIVE_FIELDS };
