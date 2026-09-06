/**
 * P1.5 — MERGING TWO CONTACT RECORDS (addendum §29, §15, §14).
 *
 * Deterministic ids stop new duplicates being created. They do nothing about the duplicates
 * already in the datastore, created by seven `addDoc` call sites over the life of the app, so
 * a merge operation is the other half of the same work.
 *
 * This module contains only the DECISION — given two records, what does the survivor look
 * like. It touches no datastore, which is why the consent and suppression rules below can be
 * tested exhaustively rather than argued about.
 *
 * THE RULE THAT MATTERS
 * ---------------------
 * A merge combines two permission states into one, and there is a safe direction. §14: unknown
 * consent is never permission. Applied to a merge, that has two distinct consequences, and
 * getting either backwards means sending mail to someone who refused it.
 *
 *   SUPPRESSION UNIONS. If either record carries an unsubscribe, a hard bounce or a complaint,
 *   the survivor carries it. A suppression is a statement the person made about the world; the
 *   fact that the system also holds a second record where they never said it is a fact about
 *   the system's bookkeeping, not about their wishes.
 *
 *   CONSENT DOES NOT UNION — it is conditional on suppression. Affirmative consent on one
 *   record survives only when NEITHER record is suppressed. A person who opted in through a
 *   form and later unsubscribed has withdrawn; merging must not resurrect the earlier opt-in
 *   just because it is recorded on a different document.
 *
 * The asymmetry is the point. Suppression is contagious across a merge and consent is not.
 */

/** Every field ActionGateway reads when deciding whether a send may proceed. */
export interface ContactPermissionState {
  consentGiven?: unknown;
  consentSource?: unknown;
  suppressed?: unknown;
  unsubscribed?: unknown;
  hardBounced?: unknown;
  complained?: unknown;
  emailStatus?: unknown;
  suppressionReason?: unknown;
}

export interface MergeableContact extends ContactPermissionState {
  id?: unknown;
  organizationId?: unknown;
  emailKey?: unknown;
  supersededBy?: unknown;
  [field: string]: unknown;
}

/**
 * The suppression signals, and the flag each one sets.
 *
 * This list is duplicated nowhere: ActionGateway's check and this merge read the same names,
 * because a merge that dropped a signal the gateway checks would produce a survivor the
 * gateway then considers mailable.
 */
export const SUPPRESSION_SIGNALS = [
  { field: 'suppressed', label: 'SUPPRESSED', test: (v: unknown) => v === true },
  { field: 'unsubscribed', label: 'UNSUBSCRIBED', test: (v: unknown) => v === true },
  { field: 'hardBounced', label: 'HARD_BOUNCE', test: (v: unknown) => v === true },
  { field: 'complained', label: 'SPAM_COMPLAINT', test: (v: unknown) => v === true },
  { field: 'emailStatus', label: 'BOUNCED', test: (v: unknown) => v === 'BOUNCED' },
] as const;

/** Which suppression signals are set on a record. */
export function suppressionLabels(record: ContactPermissionState | null | undefined): string[] {
  if (!record) return [];
  return SUPPRESSION_SIGNALS.filter((signal) => signal.test(record[signal.field])).map(
    (signal) => signal.label
  );
}

export function isSuppressed(record: ContactPermissionState | null | undefined): boolean {
  return suppressionLabels(record).length > 0;
}

/**
 * Affirmative consent, by the same test ActionGateway applies.
 *
 * `!== true` rather than a truthiness check, deliberately: the string 'false', the number 0
 * and the string 'no' are all truthy or falsy in ways that do not mean what they say, and a
 * consent decision is not the place to rely on JavaScript coercion.
 */
export function hasAffirmativeConsent(record: ContactPermissionState | null | undefined): boolean {
  return record?.consentGiven === true;
}

export type MergeRefusal =
  | { code: 'SAME_RECORD'; message: string }
  | { code: 'CROSS_TENANT'; message: string }
  | { code: 'DIFFERENT_IDENTITY'; message: string }
  | { code: 'ALREADY_SUPERSEDED'; message: string };

export type MergePlan =
  | { ok: false; refusal: MergeRefusal }
  | {
      ok: true;
      /** Fields to write onto the survivor. */
      survivorPatch: Record<string, unknown>;
      /** Fields to write onto the record being merged away. */
      duplicatePatch: Record<string, unknown>;
      /** Suppression signals inherited from the duplicate that the survivor did not have. */
      inheritedSuppression: string[];
      /** True when the merge revokes consent the survivor previously had. */
      consentRevoked: boolean;
    };

/** Fields that describe the record's place in the store rather than the person. Never copied. */
const STRUCTURAL_FIELDS = new Set([
  'id',
  'organizationId',
  'version',
  'createdAt',
  'updatedAt',
  'supersededBy',
  'mergedAt',
  'mergedFrom',
]);

/**
 * Plan a merge of `duplicate` into `survivor`.
 *
 * Pure. Returns a refusal rather than throwing, because every refusal here is a legitimate
 * data condition that a caller must answer to a user, not a programming error.
 */
export function planContactMerge(
  survivor: MergeableContact,
  duplicate: MergeableContact,
  options: { now?: string; mergedBy?: string; resume?: boolean } = {}
): MergePlan {
  const now = options.now ?? new Date().toISOString();

  const survivorId = typeof survivor.id === 'string' ? survivor.id : null;
  const duplicateId = typeof duplicate.id === 'string' ? duplicate.id : null;

  if (survivorId === null || duplicateId === null) {
    return {
      ok: false,
      refusal: {
        code: 'SAME_RECORD',
        message: 'Both records must carry a string id before they can be merged.',
      },
    };
  }

  if (survivorId === duplicateId) {
    return {
      ok: false,
      refusal: {
        code: 'SAME_RECORD',
        message: `Refusing to merge ${survivorId} into itself.`,
      },
    };
  }

  // A merge rewrites one tenant's records to point at another tenant's contact. There is no
  // legitimate caller for that, and the request that asks for it is the one to worry about.
  if (survivor.organizationId !== duplicate.organizationId) {
    return {
      ok: false,
      refusal: {
        code: 'CROSS_TENANT',
        message:
          'Refusing to merge contacts belonging to different organisations. A merge moves ' +
          'conversation history, and moving it across a tenant boundary is a data breach.',
      },
    };
  }

  // Merging a record that has already been merged away would build a chain, and the reparenting
  // step does not follow chains — rows would be left pointing at a record that is itself
  // superseded, which is the same orphan the merge exists to remove.
  if (typeof survivor.supersededBy === 'string' && survivor.supersededBy.length > 0) {
    return {
      ok: false,
      refusal: {
        code: 'ALREADY_SUPERSEDED',
        message: `Survivor ${survivorId} has already been merged into ${survivor.supersededBy}.`,
      },
    };
  }
  if (typeof duplicate.supersededBy === 'string' && duplicate.supersededBy.length > 0) {
    // RESUMING IS NOT THE SAME AS CHAINING. A merge reparents rows that a Firestore
    // transaction cannot enumerate itself, so the caller queries first and commits second, and
    // a row created in between still points at the merged-away record. The operation therefore
    // has to be re-runnable, or the only way to repair a straggler is by hand.
    //
    // Re-running is permitted only when the record was superseded into THIS survivor. Any
    // other target is a chain, and reparenting does not follow chains — see below.
    const isResume = options.resume === true && duplicate.supersededBy === survivorId;
    if (!isResume) {
      return {
        ok: false,
        refusal: {
          code: 'ALREADY_SUPERSEDED',
          message:
            `Contact ${duplicateId} has already been merged into ${duplicate.supersededBy}` +
            (duplicate.supersededBy === survivorId
              ? '. Pass resume to reparent any rows left behind.'
              : '.'),
        },
      };
    }
  }

  const survivorSuppression = suppressionLabels(survivor);
  const duplicateSuppression = suppressionLabels(duplicate);
  const inheritedSuppression = duplicateSuppression.filter(
    (label) => !survivorSuppression.includes(label)
  );

  const survivorPatch: Record<string, unknown> = {};

  // 1. Suppression unions. Every signal set on the duplicate is set on the survivor.
  for (const signal of SUPPRESSION_SIGNALS) {
    if (signal.test(duplicate[signal.field]) && !signal.test(survivor[signal.field])) {
      survivorPatch[signal.field] = duplicate[signal.field];
    }
  }

  const anySuppressed = survivorSuppression.length > 0 || duplicateSuppression.length > 0;

  if (anySuppressed) {
    const reasons = [survivor.suppressionReason, duplicate.suppressionReason]
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .join('; ');
    const allLabels = Array.from(new Set([...survivorSuppression, ...duplicateSuppression]));
    survivorPatch.suppressionReason =
      reasons.length > 0 ? reasons : `Suppressed on merge (${allLabels.join(', ')}).`;
  }

  // 2. Consent is conditional on suppression, and does not union on its own.
  const consentRevoked = hasAffirmativeConsent(survivor) && anySuppressed;

  if (anySuppressed) {
    // Whatever either record said about consent, a suppression outranks it.
    survivorPatch.consentGiven = false;
    survivorPatch.consentRevokedAt = now;
    survivorPatch.consentRevokedReason =
      'Consent withdrawn by a suppression signal present on a merged record.';
  } else if (!hasAffirmativeConsent(survivor) && hasAffirmativeConsent(duplicate)) {
    // Neither record is suppressed and the duplicate carries the evidence. Absence of a
    // consent record on the survivor is absence of evidence, not evidence of refusal, so the
    // recorded opt-in is the more informed of the two states.
    survivorPatch.consentGiven = true;
    if (duplicate.consentSource !== undefined) survivorPatch.consentSource = duplicate.consentSource;
  }

  // 3. Non-permission fields: the survivor wins, the duplicate fills gaps. Permission fields
  // are excluded because they were decided above by rules that are not "first non-empty wins".
  const permissionFields = new Set<string>([
    ...SUPPRESSION_SIGNALS.map((s) => s.field as string),
    'consentGiven',
    'consentSource',
    'suppressionReason',
    'consentRevokedAt',
    'consentRevokedReason',
  ]);

  for (const [field, value] of Object.entries(duplicate)) {
    if (STRUCTURAL_FIELDS.has(field) || permissionFields.has(field)) continue;
    if (value === undefined || value === null || value === '') continue;
    const current = survivor[field];
    if (current === undefined || current === null || current === '') {
      survivorPatch[field] = value;
    }
  }

  survivorPatch.updatedAt = now;
  // Deduplicated, because a resumed merge would otherwise record the same source twice and the
  // history would suggest two merges happened where there was one.
  const priorSources = Array.isArray(survivor.mergedFrom) ? survivor.mergedFrom : [];
  survivorPatch.mergedFrom = priorSources.includes(duplicateId)
    ? priorSources
    : [...priorSources, duplicateId];

  const duplicatePatch: Record<string, unknown> = {
    supersededBy: survivorId,
    status: 'MERGED',
    mergedAt: now,
    updatedAt: now,
    // The merged-away record keeps its suppression flags. It is retained rather than deleted
    // so the audit trail survives, and a stray writer that still holds its id must not find a
    // record that looks mailable.
    consentGiven: false,
  };
  if (options.mergedBy) duplicatePatch.mergedBy = options.mergedBy;

  return { ok: true, survivorPatch, duplicatePatch, inheritedSuppression, consentRevoked };
}
