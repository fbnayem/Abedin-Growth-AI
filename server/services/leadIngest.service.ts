import { doc, getDoc, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { createContactIfAbsent } from '../lib/identityStore';
import { buildContactDocument, type AddressProvenance, type ContactProvenance } from '../domain/contactDocument';
import { evaluateLawfulBasis, type AddressType, type LawfulBasis } from '../domain/lawfulBasis';

/**
 * THE ONE WRITE PATH EVERY LEAD SOURCE ENDS AT (§14, §16).
 *
 * Four sources produce candidate contacts — a CSV, a manual entry, a paid discovery provider
 * and a scraping worker — and all four arrive here. That is not tidiness. Dedup, no-overwrite,
 * provenance and the lawful-basis verdict are properties of THIS function, so a new source gets
 * them by construction rather than by its author remembering to reimplement them.
 *
 * The alternative is what usually happens: the CSV importer is written carefully, and six weeks
 * later the scraper writes contacts with a `setDoc` because that was quicker. The scraper is
 * then the way to clear an unsubscribe, and nothing in the CSV importer's test suite notices.
 *
 * WHAT THIS FUNCTION GUARANTEES, WHATEVER THE SOURCE
 * -------------------------------------------------
 * 1. A PREVIEW WRITES NOTHING. The mode is checked once, and the preview branch calls only
 *    `getDoc`.
 * 2. AN EXISTING RECORD IS NEVER TOUCHED. Through `createContactIfAbsent`, which refuses rather
 *    than overwrites. The existing record may carry an unsubscribe.
 * 3. THE BASIS IS EVALUATED ON THE DOCUMENT THAT WILL ACTUALLY BE STORED, not on a summary of
 *    it, so a preview cannot promise a send the commit will not permit.
 * 4. `consentGiven` IS DERIVED FROM THE BASIS. No source supplies it — see
 *    `server/domain/contactDocument.ts`.
 * 5. EVERY RECORD CARRIES ITS PROVENANCE. Where it came from and when, because the Article 14
 *    notice has to say so and a record that cannot carry the notice cannot be mailed on
 *    legitimate interest.
 */

export type IngestMode = 'PREVIEW' | 'COMMIT';
export type IngestStatus = 'WOULD_CREATE' | 'CREATED' | 'DUPLICATE' | 'FAILED';

/** A candidate contact, already validated and normalised by whichever source produced it. */
export interface IngestRecord {
  /** Where this came from, for the report: a line number, a provider record id, a URL. */
  readonly ref: string;
  /** Present for file imports, so a refusal can be found in the file. */
  readonly line?: number;
  readonly email: string;
  /** The derived document id. The source computes it so it can dedup within its own batch. */
  readonly contactId: string;
  /** Allowlisted fields only. A source that puts a suppression flag here writes nothing. */
  readonly fields: Readonly<Record<string, string>>;
}

/** The lawful basis under which a whole batch is being ingested. One decision, not per record. */
export interface BasisSettings {
  readonly basis: LawfulBasis;
  readonly liaId?: string;
  readonly consentEvidence?: string;
  readonly consentSource?: string;
  readonly country?: string;
  readonly addressType?: AddressType;
}

export interface IngestOutcome {
  readonly ref: string;
  readonly line?: number;
  readonly email: string;
  readonly contactId: string;
  readonly status: IngestStatus;
  /** Whether the resulting record may lawfully be emailed. Often false, and that is honest. */
  readonly mailable: boolean;
  readonly reason: string;
  readonly refusalCode: string | null;
}

export interface IngestResult {
  readonly outcomes: IngestOutcome[];
  readonly wouldCreate: number;
  readonly created: number;
  readonly duplicates: number;
  readonly failed: number;
  /** New records that may be emailed. A duplicate is never counted, whatever its basis says. */
  readonly mailable: number;
}

/** How many existence checks run at once during a preview. */
const PREVIEW_CONCURRENCY = 20;

/**
 * The document a record would become.
 *
 * Built once and used for BOTH the mailability verdict and the write, so the verdict a preview
 * shows is a verdict about the document that will actually exist. Evaluating a hand-assembled
 * facts object instead is how a preview comes to promise something the commit does not deliver.
 */
export function prospectiveDocument(
  record: IngestRecord,
  settings: BasisSettings,
  provenance: ContactProvenance,
  address: AddressProvenance,
  orgId: string,
  actor: string,
  type: 'LEAD' | 'INVESTOR' | 'PARTNER',
  now: Date
): Record<string, unknown> {
  const f = record.fields;
  return buildContactDocument(
    {
      email: record.email,
      name: f.name,
      firstName: f.firstName,
      lastName: f.lastName,
      title: f.title,
      phone: f.phone,
      linkedinUrl: f.linkedinUrl,
      companyName: f.companyName,
      companyWebsite: f.companyWebsite,
      industry: f.industry,
      // A record's own country wins over the batch default; the batch fills the gaps.
      country: f.country ?? settings.country,
      employeeCount: f.employeeCount,
      notes: f.notes,
      timeZone: f.timeZone,
    },
    {
      id: record.contactId,
      organizationId: orgId,
      type,
      status: 'NEW',
      now,
      provenance,
      address,
      basis: {
        basis: settings.basis,
        addressType: (f.addressType as AddressType | undefined) ?? settings.addressType,
        consentEvidence: f.consentEvidence ?? settings.consentEvidence,
        consentSource: f.consentSource ?? settings.consentSource,
        liaId: settings.liaId,
        // Only ever per record. A batch-level "the notice was sent" checkbox is an assertion
        // made in the moment; a per-record timestamp came from a system that recorded it.
        article14NoticeSentAt: f.article14NoticeSentAt,
        recordedBy: actor,
      },
    }
  );
}

/** Existence checks, bounded. A 2,000-record preview must not open 2,000 reads at once. */
export async function existingIds(orgId: string, ids: readonly string[]): Promise<Set<string>> {
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
 * Preview or commit a batch of candidate contacts.
 *
 * `actor` is a named operator, always. Every caller checks attribution before reaching here —
 * the importer, the discovery service and the scrape worker each refuse an unattributed
 * request — because the actor is written into each record as the consent recorder, and a basis
 * whose recorder cannot be named is one that cannot be defended.
 */
export async function ingestRecords(
  orgId: string,
  records: readonly IngestRecord[],
  settings: BasisSettings,
  provenance: ContactProvenance,
  address: AddressProvenance,
  actor: string,
  options: { mode: IngestMode; type?: 'LEAD' | 'INVESTOR' | 'PARTNER'; now?: Date }
): Promise<IngestResult> {
  const now = options.now ?? new Date();
  const type = options.type ?? 'LEAD';
  const outcomes: IngestOutcome[] = [];
  let created = 0;
  let wouldCreate = 0;
  let duplicates = 0;
  let failed = 0;
  let mailable = 0;

  if (options.mode === 'PREVIEW') {
    // Reads only. Nothing below this line writes, and that is the invariant the suites pin.
    const present = await existingIds(
      orgId,
      records.map((r) => r.contactId)
    );
    for (const record of records) {
      const document = prospectiveDocument(record, settings, provenance, address, orgId, actor, type, now);
      const verdict = evaluateLawfulBasis(document);
      const isDuplicate = present.has(record.contactId);
      if (isDuplicate) duplicates++;
      else wouldCreate++;
      if (!isDuplicate && verdict.ok) mailable++;
      outcomes.push({
        ref: record.ref,
        line: record.line,
        email: record.email,
        contactId: record.contactId,
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
    return { outcomes, wouldCreate, created, duplicates, failed, mailable };
  }

  for (const record of records) {
    const document = prospectiveDocument(record, settings, provenance, address, orgId, actor, type, now);
    const verdict = evaluateLawfulBasis(document);
    const result = await createContactIfAbsent(orgId, record.email, () => document);

    if (result.ok) {
      created++;
      if (verdict.ok) mailable++;
      outcomes.push({
        ref: record.ref,
        line: record.line,
        email: record.email,
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
        ref: record.ref,
        line: record.line,
        email: record.email,
        contactId: result.id,
        status: 'DUPLICATE',
        mailable: false,
        reason:
          'A contact with this address already exists. It was left exactly as it is: an ' +
          'ingest that updated it would be a way to undo an unsubscribe.',
        refusalCode: 'ALREADY_EXISTS',
      });
      continue;
    }

    // UNUSABLE_EMAIL should be unreachable — the source derived an id from this address — and
    // STORE_UNAVAILABLE is a real runtime condition. Neither aborts the run: the records
    // already created are real, and the report has to account for every one.
    failed++;
    outcomes.push({
      ref: record.ref,
      line: record.line,
      email: record.email,
      contactId: record.contactId,
      status: 'FAILED',
      mailable: false,
      reason: result.message,
      refusalCode: result.code,
    });
  }

  return { outcomes, wouldCreate, created, duplicates, failed, mailable };
}
