import { createHash } from 'node:crypto';
import type { AddressProvenance } from '../domain/contactDocument';
import type { AddressSourceKind } from '../domain/addressSource';
import { store } from '../store';
import type { ContactProvenance } from '../domain/contactDocument';
import type { AddressType, LawfulBasis } from '../domain/lawfulBasis';
import {
  planImport,
  type ImportPlan,
  type ParseRefusalCode,
  type RefusedRow,
} from '../domain/leadImport';
import { ingestRecords, type IngestMode, type IngestRecord, type IngestStatus } from './leadIngest.service';
import type { Attribution } from '../domain/operatorAction';

/**
 * CSV / LIST IMPORT — THE EXECUTION (§2, §14, §16, §32).
 *
 * THIS FILE IS THE CSV-SHAPED HALF. The write itself — dedup, no-overwrite, provenance and the
 * basis verdict — lives in `server/services/leadIngest.service.ts`, which every lead source
 * ends at. What is here is everything that is specific to a file: the plan, the approval
 * fingerprint, and the refusal report.
 *
 * THE ONE RULE BOTH HALVES KEEP
 * -----------------------------
 * A PREVIEW WRITES NOTHING. Not a contact, not an account, not a counter. The operator is
 * shown exactly what a commit would do, decides, and only then does anything reach the store.
 * This is the difference between an import an operator can trust and one they find out about
 * afterwards, and it is enforced structurally: the preview branch of `ingestRecords` calls only
 * `getDoc`.
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

export type ImportMode = IngestMode;

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
  /**
   * How the ADDRESSES in this file were obtained. One decision for the whole file, like `basis`,
   * and for the same reason: a column an external source controls is a source naming the route
   * that decides which assessment covers it.
   */
  readonly addressSourceKind: AddressSourceKind;
  readonly addressSourceEvidence: string;
  readonly type?: 'LEAD' | 'INVESTOR' | 'PARTNER';
}

/** The shared type, re-exported so a caller of this module needs only one import. */
export type RowStatus = IngestStatus;

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
    // IN THE FINGERPRINT, and this one is easy to miss. `PLAN_CHANGED` exists because changing
    // the basis from consent to legitimate interest changes what an import MEANS without changing
    // a byte of the file. The address route now decides which balancing assessment can cover
    // every contact the file creates, so the same argument applies to it exactly: previewing as
    // EMPLOYER_WEBSITE and committing as PROVIDER must not match a hash.
    addressSourceKind: batch.addressSourceKind,
    addressSourceEvidence: batch.addressSourceEvidence,
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

  const provenance: ContactProvenance = {
    source: 'IMPORT',
    sourceEvidence: batch.sourceEvidence,
    sourceCollectedAt: (options.now ?? new Date()).toISOString(),
    importBatchId: batchId,
  };

  // STATED BY THE OPERATOR, per batch, and never defaulted. An importer genuinely cannot know how
  // the addresses in a file were obtained; only the person who has the file can. `PUBLIC_DIRECTORY`
  // would be exactly the plausible-looking default that is a guess, and §14 is explicit that an
  // unknown must never resolve to a permission.
  //
  // Per BATCH and not per row, which has an honest cost: a file mixing published addresses with
  // guessed ones has to be split. That is the right trade -- the alternative is a column an
  // external source controls, and a source that can name its own address route is choosing the
  // assessment that covers it.
  const address: AddressProvenance = {
    addressSourceKind: batch.addressSourceKind,
    addressSourceEvidence: batch.addressSourceEvidence,
    addressCollectedAt: (options.now ?? new Date()).toISOString(),
  };

  // Every candidate row goes through the one write path, which is also what the discovery
  // provider and the scrape worker use. Dedup, no-overwrite and the basis verdict are
  // properties of that function rather than of this one.
  const records: IngestRecord[] = plan.rows.map((row) => ({
    ref: `line ${row.line}`,
    line: row.line,
    email: row.email,
    contactId: row.contactId,
    fields: row.fields,
  }));

  const result = await ingestRecords(
    orgId,
    records,
    {
      basis: batch.basis,
      liaId: batch.liaId,
      consentEvidence: batch.consentEvidence,
      consentSource: batch.consentSource,
      country: batch.country,
      addressType: batch.addressType,
    },
    provenance,
    address,
    actor,
    { mode, type: batch.type ?? 'LEAD', now: options.now }
  );

  const outcomes: RowOutcome[] = result.outcomes.map((o) => ({
    line: o.line ?? 0,
    email: o.email,
    contactId: o.contactId,
    status: o.status,
    mailable: o.mailable,
    reason: o.reason,
    refusalCode: o.refusalCode,
  }));

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
      wouldCreate: result.wouldCreate,
      created: result.created,
      duplicates: result.duplicates,
      refused: plan.refused.length,
      failed: result.failed,
      mailable: result.mailable,
      notYetMailable: outcomes.filter((o) => !o.mailable && o.status !== 'DUPLICATE').length,
    },
    outcomes,
    refused: plan.refused,
  };
}
