import { createHash } from 'node:crypto';
import { doc, getDoc, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { createContactIfAbsent } from '../lib/identityStore';
import { buildContactDocument, type ContactProvenance } from '../domain/contactDocument';
import {
  evaluateLawfulBasis,
  type AddressType,
  type LawfulBasis,
} from '../domain/lawfulBasis';
import {
  planImport,
  type ImportPlan,
  type ParseRefusalCode,
  type PlannedRow,
  type RefusedRow,
} from '../domain/leadImport';
import type { Attribution } from '../domain/operatorAction';

/**
 * CSV / LIST IMPORT — THE EXECUTION (§2, §14, §16, §32).
 *
 * THE ONE RULE THIS FILE EXISTS TO KEEP
 * -------------------------------------
 * A PREVIEW WRITES NOTHING. Not a contact, not an account, not a counter. The operator is
 * shown exactly what a commit would do, decides, and only then does anything reach the store.
 * This is the difference between an import an operator can trust and one they find out about
 * afterwards, and it is enforced structurally: the preview path never touches a write function.
 * `importLeads` branches once, at the top, and the branch that previews calls only `getDoc`.
 *
 * THE SECOND RULE: THE FILE THE OPERATOR APPROVED IS THE FILE THAT IS COMMITTED
 * ----------------------------------------------------------------------------
 * The preview returns a `planHash` over the text and the batch settings. A commit must echo it.
 * Without that, an operator could preview a clean 40-row file, and a commit could carry a
 * different 4,000-row one with the same request shape — approving one thing and doing another.
 * The hash is not a security boundary against the operator themselves; it is a guard against
 * the far more likely accident of a stale tab or a re-picked file.
 *
 * THE THIRD RULE: "IMPORTED" AND "CONTACTABLE" ARE DIFFERENT NUMBERS
 * -----------------------------------------------------------------
 * Every row's prospective document is run through `evaluateLawfulBasis` and reported as mailable
 * or not, with the reason. An import that creates 412 records of which 9 can be emailed reports
 * both numbers. Reporting only the first is the fabricated-success shape: it looks like a
 * working lead pipeline right up until the first campaign sends nine emails.
 *
 * WHAT A DUPLICATE MEANS HERE
 * ---------------------------
 * A row whose address already exists is reported as DUPLICATE and the existing record is left
 * exactly as it is. Not merged, not updated, not enriched. The existing record may carry an
 * unsubscribe, and an import that updated it would be a way to walk one back — the same
 * overwrite-shaped hole `createContactIfAbsent` was built to close.
 */

export type ImportMode = 'PREVIEW' | 'COMMIT';

export interface ImportBatchSettings {
  /** One deliberate decision for the whole file. Never read from a column. */
  readonly basis: LawfulBasis;
  /** Which balancing assessment covers this list. Required for LEGITIMATE_INTEREST. */
  readonly liaId?: string;
  /** Applied to rows that do not carry their own. */
  readonly consentEvidence?: string;
  readonly consentSource?: string;
  readonly country?: string;
  readonly addressType?: AddressType;
  /** Where this list came from, in a form a person could check. Required. */
  readonly sourceEvidence: string;
  readonly type?: 'LEAD' | 'INVESTOR' | 'PARTNER';
}

export type RowStatus = 'WOULD_CREATE' | 'CREATED' | 'DUPLICATE' | 'FAILED';

export interface RowOutcome {
  readonly line: number;
  readonly email: string;
  readonly contactId: string;
  readonly status: RowStatus;
  /** Whether the resulting record may lawfully be emailed. Often false, and that is honest. */
  readonly mailable: boolean;
  readonly reason: string;
  readonly refusalCode: string | null;
}

export interface ImportCounts {
  readonly dataRows: number;
  /** What a commit would create. Zero in COMMIT mode, where `created` is the real number. */
  readonly wouldCreate: number;
  readonly created: number;
  readonly duplicates: number;
  readonly refused: number;
  readonly failed: number;
  readonly mailable: number;
  readonly notYetMailable: number;
}

export type ImportOutcome =
  | {
      readonly ok: true;
      readonly mode: ImportMode;
      readonly batchId: string;
      readonly planHash: string;
      readonly delimiter: string;
      readonly mappedColumns: Readonly<Record<string, string>>;
      readonly ignoredColumns: readonly string[];
      readonly counts: ImportCounts;
      readonly outcomes: readonly RowOutcome[];
      readonly refused: readonly RefusedRow[];
    }
  | {
      readonly ok: false;
      readonly code:
        | ParseRefusalCode
        | 'ATTRIBUTION_REQUIRED'
        | 'STORE_UNAVAILABLE'
        | 'NO_LIA'
        | 'NO_CONSENT_EVIDENCE'
        | 'NO_SOURCE_EVIDENCE'
        | 'PLAN_CHANGED';
      readonly message: string;
    };

/** How many existence checks run at once during a preview. */
const PREVIEW_CONCURRENCY = 20;

/**
 * A stable fingerprint of exactly what the operator approved.
 *
 * Over the raw text AND the batch settings, because changing the basis from consent to
 * legitimate interest changes what the import means without changing a byte of the file.
 */
export function planFingerprint(text: string, batch: ImportBatchSettings): string {
  const canonical = JSON.stringify({
    basis: batch.basis,
    liaId: batch.liaId ?? null,
    consentEvidence: batch.consentEvidence ?? null,
    consentSource: batch.consentSource ?? null,
    country: batch.country ?? null,
    addressType: batch.addressType ?? null,
    sourceEvidence: batch.sourceEvidence,
    type: batch.type ?? 'LEAD',
  });
  // A NUL byte between the two halves, so no rearrangement of settings and file content can
  // produce the same digest as a different pair.
  return createHash('sha256')
    .update(canonical)
    .update(Buffer.from([0]))
    .update(text, 'utf8')
    .digest('hex');
}

/** The batch id, derived from the fingerprint so the same approved plan groups the same way. */
function batchIdFor(hash: string): string {
  return `imp_${hash.slice(0, 16)}`;
}

/**
 * The prospective document for a row: what the store would hold if this row were committed.
 *
 * Built once and used for BOTH the mailability verdict and the write, so the verdict shown in
 * the preview is a verdict about the document that will actually exist. Evaluating a
 * hand-assembled facts object instead is how a preview comes to promise something the commit
 * does not deliver.
 */
function documentFor(
  row: PlannedRow,
  batch: ImportBatchSettings,
  orgId: string,
  actor: string,
  batchId: string,
  now: Date
): Record<string, unknown> {
  const f = row.fields;
  const provenance: ContactProvenance = {
    source: 'IMPORT',
    sourceEvidence: batch.sourceEvidence,
    sourceCollectedAt: now.toISOString(),
    importBatchId: batchId,
  };

  return buildContactDocument(
    {
      email: row.email,
      name: f.name,
      firstName: f.firstName,
      lastName: f.lastName,
      title: f.title,
      phone: f.phone,
      linkedinUrl: f.linkedinUrl,
      companyName: f.companyName,
      companyWebsite: f.companyWebsite,
      industry: f.industry,
      // A row's own country wins over the batch default; the batch fills the gaps.
      country: f.country ?? batch.country,
      employeeCount: f.employeeCount,
      notes: f.notes,
      timeZone: f.timeZone,
    },
    {
      id: row.contactId,
      organizationId: orgId,
      type: batch.type ?? 'LEAD',
      status: 'NEW',
      now,
      provenance,
      basis: {
        basis: batch.basis,
        addressType: (f.addressType as AddressType | undefined) ?? batch.addressType,
        consentEvidence: f.consentEvidence ?? batch.consentEvidence,
        consentSource: f.consentSource ?? batch.consentSource,
        liaId: batch.liaId,
        // Only ever per row. A batch-level "the notice was sent" checkbox is an assertion made
        // in the moment; a per-row timestamp came from a system that recorded the sending.
        article14NoticeSentAt: f.article14NoticeSentAt,
        recordedBy: actor,
      },
    }
  );
}

/** Existence checks, bounded. A 2,000-row preview must not open 2,000 reads at once. */
async function existingIds(orgId: string, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += PREVIEW_CONCURRENCY) {
    const slice = ids.slice(i, i + PREVIEW_CONCURRENCY);
    const snaps = await Promise.all(
      slice.map((id) => getDoc(doc(store, orgPath(orgId, 'contacts'), id)))
    );
    snaps.forEach((snap, n) => {
      if (snap.exists()) found.add(slice[n]);
    });
  }
  return found;
}

/**
 * Batch-level settings that are wrong in a way no row can fix.
 *
 * Refused up front rather than per row, because 2,000 identical row refusals is not a report,
 * it is a wall. A row-level problem stays a row-level problem.
 */
function batchRefusal(
  batch: ImportBatchSettings,
  plan: ImportPlan
): { code: 'NO_LIA' | 'NO_CONSENT_EVIDENCE' | 'NO_SOURCE_EVIDENCE'; message: string } | null {
  if (typeof batch.sourceEvidence !== 'string' || batch.sourceEvidence.trim() === '') {
    return {
      code: 'NO_SOURCE_EVIDENCE',
      message:
        'An import needs to say where the list came from. That text is what an Article 14 ' +
        'notice has to tell each person, so a record without it cannot lawfully be mailed on ' +
        'legitimate interest and cannot be explained later.',
    };
  }

  if (batch.basis === 'LEGITIMATE_INTEREST') {
    if (typeof batch.liaId !== 'string' || batch.liaId.trim() === '') {
      return {
        code: 'NO_LIA',
        message:
          'Importing on legitimate interest requires the id of the balancing assessment that ' +
          'covers this list. The assessment is what makes the basis defensible, and it applies ' +
          'to the batch, not to individual rows.',
      };
    }
  }

  if (batch.basis === 'CONSENT') {
    const hasBatchEvidence =
      typeof batch.consentEvidence === 'string' && batch.consentEvidence.trim() !== '';
    const hasColumn = Object.values(plan.mapped).includes('consentEvidence');
    if (!hasBatchEvidence && !hasColumn) {
      return {
        code: 'NO_CONSENT_EVIDENCE',
        message:
          'Importing on consent requires evidence of where and when each person consented, ' +
          'either as a column in the file or as one statement covering the batch. A consent ' +
          'that cannot be shown is one that cannot be defended, so every row would refuse.',
      };
    }
  }

  return null;
}

/**
 * Preview or commit an import.
 *
 * `expectedPlanHash` is required for COMMIT and ignored for PREVIEW: a commit has to name the
 * plan it is committing.
 */
export async function importLeads(
  orgId: string,
  text: unknown,
  batch: ImportBatchSettings,
  by: Attribution,
  options: { mode: ImportMode; expectedPlanHash?: string; now?: Date } = { mode: 'PREVIEW' }
): Promise<ImportOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }

  // Required for a PREVIEW as well as a COMMIT, which is not belt and braces. The recorded
  // actor is part of the consent record and therefore part of the mailability verdict, so a
  // preview run without one would show refusals the commit would not produce, or the reverse.
  if (by.kind !== 'IDENTIFIED') {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Importing contacts needs an identified operator: ${by.why}. The importer's name is ` +
        `part of every record the import creates, which is what makes the basis defensible.`,
    };
  }
  const actor = by.actor;

  const plan = planImport(text);
  if (plan.ok === false) return plan;

  const refusal = batchRefusal(batch, plan);
  if (refusal !== null) return { ok: false, ...refusal };

  const planHash = planFingerprint(text as string, batch);
  const batchId = batchIdFor(planHash);
  const mode = options.mode;

  if (mode === 'COMMIT' && options.expectedPlanHash !== planHash) {
    return {
      ok: false,
      code: 'PLAN_CHANGED',
      message:
        'This commit does not match the plan that was previewed — the file or the batch ' +
        'settings have changed since. Preview again and approve what is actually there, ' +
        'rather than committing something nobody has looked at.',
    };
  }

  const now = options.now ?? new Date();
  const outcomes: RowOutcome[] = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;
  let mailable = 0;

  const verdictOf = (document: Record<string, unknown>) => evaluateLawfulBasis(document);

  if (mode === 'PREVIEW') {
    // Reads only. Nothing below this line writes, and that is the invariant the suite pins.
    const present = await existingIds(
      orgId,
      plan.rows.map((r) => r.contactId)
    );
    for (const row of plan.rows) {
      const document = documentFor(row, batch, orgId, actor, batchId, now);
      const verdict = verdictOf(document);
      const isDuplicate = present.has(row.contactId);
      if (isDuplicate) duplicates++;
      if (!isDuplicate && verdict.ok) mailable++;
      outcomes.push({
        line: row.line,
        email: row.email,
        contactId: row.contactId,
        status: isDuplicate ? 'DUPLICATE' : 'WOULD_CREATE',
        mailable: !isDuplicate && verdict.ok,
        reason: isDuplicate
          ? 'A contact with this address already exists and would be left exactly as it is.'
          : verdict.ok
            ? verdict.why
            : verdict.message,
        refusalCode: isDuplicate ? 'ALREADY_EXISTS' : verdict.ok ? null : verdict.code,
      });
    }
  } else {
    for (const row of plan.rows) {
      const document = documentFor(row, batch, orgId, actor, batchId, now);
      const verdict = verdictOf(document);
      const result = await createContactIfAbsent(orgId, row.email, () => document);

      if (result.ok) {
        created++;
        if (verdict.ok) mailable++;
        outcomes.push({
          line: row.line,
          email: row.email,
          contactId: result.id,
          status: 'CREATED',
          mailable: verdict.ok,
          reason: verdict.ok ? verdict.why : verdict.message,
          refusalCode: verdict.ok ? null : verdict.code,
        });
        continue;
      }

      if (result.code === 'ALREADY_EXISTS') {
        duplicates++;
        outcomes.push({
          line: row.line,
          email: row.email,
          contactId: result.id,
          status: 'DUPLICATE',
          mailable: false,
          reason:
            'A contact with this address already exists. It was left exactly as it is: an ' +
            'import that updated it would be a way to undo an unsubscribe.',
          refusalCode: 'ALREADY_EXISTS',
        });
        continue;
      }

      // UNUSABLE_EMAIL should be unreachable — the planner derived an id from this address —
      // and STORE_UNAVAILABLE is a real runtime condition. Neither is allowed to abort the
      // run: the rows already created are real, and the report has to account for every row.
      failed++;
      outcomes.push({
        line: row.line,
        email: row.email,
        contactId: row.contactId,
        status: 'FAILED',
        mailable: false,
        reason: result.message,
        refusalCode: result.code,
      });
    }
  }

  return {
    ok: true,
    mode,
    batchId,
    planHash,
    delimiter: plan.delimiter,
    mappedColumns: plan.mapped,
    ignoredColumns: plan.ignored,
    counts: {
      dataRows: plan.rows.length + plan.refused.length,
      wouldCreate: mode === 'PREVIEW' ? outcomes.filter((o) => o.status === 'WOULD_CREATE').length : 0,
      created: mode === 'COMMIT' ? created : 0,
      duplicates,
      refused: plan.refused.length,
      failed,
      mailable,
      notYetMailable: outcomes.filter((o) => !o.mailable && o.status !== 'DUPLICATE').length,
    },
    outcomes,
    refused: plan.refused,
  };
}
