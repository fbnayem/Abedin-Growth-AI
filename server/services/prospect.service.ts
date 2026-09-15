import { collection, doc, getDoc, getDocs, limit as limitTo, orderBy, query, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { validateProspect, type ProspectRefusalCode } from '../domain/prospect';
import { validateCandidate } from '../domain/leadCandidate';
import { ingestRecords, type BasisSettings, type IngestMode } from './leadIngest.service';
import type { ContactProvenance } from '../domain/contactDocument';
import type { Attribution } from '../domain/operatorAction';

/**
 * PROSPECTS: CREATING THEM, AND TURNING THEM INTO CONTACTS (§14, §16).
 *
 * `server/domain/prospect.ts` says what a prospect is and why it is not a contact. This is the
 * only thing that writes one, and the only thing that promotes one.
 *
 * FOUR PROPERTIES, EACH A WAY THIS COULD GO WRONG
 * -----------------------------------------------
 * 1. A PREVIEW WRITES NOTHING, the same rule `ingestRecords` enforces and for the same reason.
 *    The preview branch calls only `getDoc`.
 *
 * 2. AN EXISTING PROSPECT IS NEVER OVERWRITTEN. A second import of the same list must not reset
 *    a record somebody has since worked on — and a prospect accumulates exactly the kind of
 *    state that matters: the notes from the person who looked at the profile, and the link to
 *    the contact it was promoted into.
 *
 * 3. PROMOTION GOES THROUGH THE ONE WRITE PATH. `promoteProspect` does not create a contact
 *    itself; it calls `validateCandidate` and then `ingestRecords`, so a promoted prospect gets
 *    dedup, no-overwrite, derived `consentGiven` and a lawful-basis verdict by construction. A
 *    second create path here would be the defect `leadIngest.service.ts` opens by warning about.
 *
 * 4. PROMOTION IS IDEMPOTENT AND THE PROSPECT SURVIVES IT. The prospect is not deleted: it holds
 *    the provenance — which LinkedIn profile this person was found at, and when — and that is
 *    precisely what the Article 14 notice has to be able to say. Deleting it would destroy the
 *    evidence at the moment the record becomes one we might actually email.
 *
 * WHAT A PROSPECT CANNOT DO
 * -------------------------
 * Be emailed. Not because a check refuses it, but because nothing that sends can address it: the
 * gateway takes a `contactId` and reads `organizations/<org>/contacts/<id>`, and a prospect does
 * not live there and has no email to send to. The invariant suite asserts that absence rather
 * than trusting it, because "no path exists" is a claim that rots the moment somebody adds one.
 */

export type ProspectWriteRefusal =
  | 'STORE_UNAVAILABLE'
  | 'ATTRIBUTION_REQUIRED'
  | 'NOT_FOUND'
  | 'NO_SOURCE_EVIDENCE'
  | 'ADDRESS_ORIGIN_NOT_RECORDED'
  | 'ALREADY_PROMOTED'
  | 'VALIDATION_ERROR';

export type ProspectStatus = 'WOULD_CREATE' | 'CREATED' | 'DUPLICATE' | 'FAILED';

export interface ProspectOutcomeRow {
  /** Where this came from, for the report: a line number, a URL, a row reference. */
  readonly ref: string;
  readonly profileUrl: string | null;
  readonly prospectId: string | null;
  readonly status: ProspectStatus;
  readonly reason: string;
}

export interface ProspectBatchResult {
  readonly ok: true;
  readonly mode: IngestMode;
  readonly counts: {
    readonly wouldCreate: number;
    readonly created: number;
    readonly duplicates: number;
    readonly failed: number;
  };
  readonly outcomes: readonly ProspectOutcomeRow[];
}

export type ProspectBatchOutcome =
  | ProspectBatchResult
  | { readonly ok: false; readonly code: ProspectWriteRefusal; readonly message: string };

/** No more than this per call, matching the importer's own row ceiling. */
export const MAX_PROSPECT_BATCH = 2_000;

function identifiedActor(by: Attribution): string | null {
  return by.kind === 'IDENTIFIED' ? by.actor : null;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function prospectRef(orgId: string, prospectId: string) {
  return doc(store, orgPath(orgId, 'prospects'), prospectId);
}

/** Existence checks, bounded. A two-thousand-row preview must not open two thousand reads. */
const PREVIEW_CONCURRENCY = 25;

async function existingProspectIds(orgId: string, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += PREVIEW_CONCURRENCY) {
    const slice = ids.slice(i, i + PREVIEW_CONCURRENCY);
    const snaps = await Promise.all(slice.map((id) => getDoc(prospectRef(orgId, id))));
    snaps.forEach((snap, n) => {
      if (snap.exists()) found.add(slice[n]);
    });
  }
  return found;
}

/**
 * Create a batch of prospects, or preview what would be created.
 *
 * No `BasisSettings` parameter, deliberately. A prospect has no lawful basis because a prospect
 * is not contactable, and accepting a basis here would create a record that appeared to carry
 * permission for something it cannot do. The basis is chosen at PROMOTION, when there is an
 * address and the decision means something.
 */
export async function createProspects(
  orgId: string,
  records: readonly Readonly<Record<string, unknown>>[],
  provenance: ContactProvenance,
  by: Attribution,
  options: { mode: IngestMode; now?: Date } = { mode: 'PREVIEW' }
): Promise<ProspectBatchOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const actor = identifiedActor(by);
  if (actor === null) {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Creating prospects needs an identified operator: ` +
        `${by.kind === 'UNATTRIBUTED' ? by.why : 'no actor on the credential'}. These are records ` +
        `about people, and a record about a person has a name against who created it.`,
    };
  }
  if (trimmed(provenance.sourceEvidence) === null) {
    return {
      ok: false,
      code: 'NO_SOURCE_EVIDENCE',
      message:
        'A prospect batch needs to say where it came from, in a form a person could check. That ' +
        'text is what an Article 14 notice has to tell each person once they become a contact.',
    };
  }

  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const outcomes: ProspectOutcomeRow[] = [];
  let wouldCreate = 0;
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  // Validate first, then decide. Within-batch duplicates are collapsed here rather than
  // discovered at the write: one list commonly holds the same person twice, and two documents
  // for one human is the defect the canonical URL exists to prevent.
  const valid: { ref: string; profileUrl: string; prospectId: string; fields: Record<string, string> }[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of records.slice(0, MAX_PROSPECT_BATCH).entries()) {
    const ref = trimmed(raw.ref) ?? `row ${index + 1}`;
    const outcome = validateProspect(raw);
    if (!outcome.ok) {
      failed++;
      outcomes.push({
        ref,
        profileUrl: null,
        prospectId: null,
        status: 'FAILED',
        reason: `${outcome.code as ProspectRefusalCode}: ${outcome.message}`,
      });
      continue;
    }
    const { profileUrl, prospectId, fields } = outcome.prospect;
    if (seen.has(prospectId)) {
      duplicates++;
      outcomes.push({
        ref,
        profileUrl,
        prospectId,
        status: 'DUPLICATE',
        reason: 'The same profile appears earlier in this batch; it is one person, so one record.',
      });
      continue;
    }
    seen.add(prospectId);
    valid.push({ ref, profileUrl, prospectId, fields: { ...fields } });
  }

  const present = await existingProspectIds(
    orgId,
    valid.map((v) => v.prospectId)
  );

  for (const v of valid) {
    const isDuplicate = present.has(v.prospectId);
    if (isDuplicate) {
      duplicates++;
      outcomes.push({
        ref: v.ref,
        profileUrl: v.profileUrl,
        prospectId: v.prospectId,
        status: 'DUPLICATE',
        reason: 'A prospect for this profile already exists and would be left exactly as it is.',
      });
      continue;
    }

    if (options.mode === 'PREVIEW') {
      wouldCreate++;
      outcomes.push({
        ref: v.ref,
        profileUrl: v.profileUrl,
        prospectId: v.prospectId,
        status: 'WOULD_CREATE',
        reason: 'Would be created. A prospect cannot be emailed; find an address and promote it.',
      });
      continue;
    }

    // Field by field, like `buildContactDocument`. A field absent from this object cannot be
    // written through this path, and no suppression or consent field appears in it.
    const document: Record<string, unknown> = {
      ...v.fields,
      id: v.prospectId,
      organizationId: orgId,
      profileUrl: v.profileUrl,
      source: provenance.source,
      sourceEvidence: provenance.sourceEvidence,
      sourceCollectedAt: provenance.sourceCollectedAt,
      importBatchId: provenance.importBatchId ?? null,
      createdAt: iso,
      createdBy: actor,
      updatedAt: iso,
      promotedToContactId: null,
      promotedAt: null,
      version: 1,
    };

    const wrote = await runTransaction(store, async (tx) => {
      // Re-read inside the transaction. The existence check above is a read that the world can
      // invalidate, and a concurrent batch importing the same list is the ordinary case rather
      // than the exotic one.
      const snap = await tx.get(prospectRef(orgId, v.prospectId));
      if (snap.exists()) return false;
      tx.set(prospectRef(orgId, v.prospectId), document);
      return true;
    });

    if (wrote) {
      created++;
      outcomes.push({
        ref: v.ref,
        profileUrl: v.profileUrl,
        prospectId: v.prospectId,
        status: 'CREATED',
        reason: 'Created. Not contactable: find an address and promote it.',
      });
    } else {
      duplicates++;
      outcomes.push({
        ref: v.ref,
        profileUrl: v.profileUrl,
        prospectId: v.prospectId,
        status: 'DUPLICATE',
        reason: 'A prospect for this profile was created concurrently and was left as it is.',
      });
    }
  }

  return {
    ok: true,
    mode: options.mode,
    counts: { wouldCreate, created, duplicates, failed },
    outcomes,
  };
}

export interface PromotionResult {
  readonly ok: true;
  readonly mode: IngestMode;
  readonly prospectId: string;
  readonly contactId: string;
  readonly alreadyPromoted: boolean;
  readonly mailable: boolean;
  readonly reason: string;
}

export type PromotionOutcome =
  | PromotionResult
  | { readonly ok: false; readonly code: ProspectWriteRefusal; readonly message: string };

/**
 * Promote a prospect to a contact, now that an address has been found.
 *
 * THE PROVENANCE COMES FROM THE PROSPECT, NOT FROM THE CALLER. This is the point of keeping the
 * record. Article 14(2)(f) asks which source the data came from, and the truthful answer for a
 * promoted prospect is "we identified you on LinkedIn at this URL on this date" — not "an
 * import", which is what a caller-supplied provenance would say because that is what the caller
 * happens to be doing at the time.
 *
 * The address itself is a separate fact and is recorded as one: `emailSource` says where the
 * address came from, which is usually not LinkedIn. IT IS REQUIRED, and it was not always.
 *
 * WHY IT BECAME REQUIRED. `lia-linkedin-2026.md` rests its necessity limb on a distinction:
 * an address DERIVED from the employer's own published naming convention is defensible under
 * that assessment, and an address BOUGHT from a data provider is a different route which it
 * does not cover. That distinction is the assessment's central argument — and while this field
 * was optional, the system recorded which of the two had happened only when somebody
 * volunteered it. The document made a claim about every record that the data could not
 * support for any of them.
 *
 * The Article 14 notice compounds it: it tells the person we "found your work email address
 * separately", and a person entitled to know the source of their data is entitled to more than
 * an admission that it came from somewhere.
 */
export async function promoteProspect(
  orgId: string,
  prospectId: string,
  email: string,
  settings: BasisSettings,
  by: Attribution,
  options: { mode: IngestMode; emailSource?: string; now?: Date } = { mode: 'PREVIEW' }
): Promise<PromotionOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  const actor = identifiedActor(by);
  if (actor === null) {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Promoting a prospect needs an identified operator: ` +
        `${by.kind === 'UNATTRIBUTED' ? by.why : 'no actor on the credential'}. It creates a ` +
        `contact under a lawful basis, and the actor is recorded as who decided that.`,
    };
  }

  // Checked here and not only in the request contract, because a service that trusts its schema
  // to have run is a service whose rule disappears the first time it is called from anywhere
  // else — a script, a job, a future route.
  const emailSource = trimmed(options.emailSource);
  if (emailSource === null) {
    return {
      ok: false,
      code: 'ADDRESS_ORIGIN_NOT_RECORDED',
      message:
        `Promoting a prospect needs \`emailSource\`: where this address came from, in a form a ` +
        `person could check. It is not a detail. The balancing assessment for LinkedIn-sourced ` +
        `contacts covers an address derived from the employer's published naming convention and ` +
        `does NOT cover one bought from a data provider, so which of the two happened decides ` +
        `whether this contact has a lawful basis at all — and the Article 14 notice tells the ` +
        `person we found their address separately, which is only half an answer without this.`,
    };
  }

  const snap = await getDoc(prospectRef(orgId, prospectId));
  if (!snap.exists()) {
    return { ok: false, code: 'NOT_FOUND', message: `No prospect ${prospectId} in this organisation.` };
  }
  const prospect = snap.data() as Record<string, unknown>;

  const alreadyContactId = trimmed(prospect.promotedToContactId);
  const candidate = validateCandidate({ ...prospect, email, profileUrl: undefined, linkedinUrl: prospect.profileUrl });
  if (!candidate.ok) {
    return { ok: false, code: 'VALIDATION_ERROR', message: `${candidate.code}: ${candidate.message}` };
  }

  if (alreadyContactId !== null) {
    // Idempotent when it resolves to the same contact, and a refusal when it does not — a
    // prospect pointing at one contact and being promoted into another is two records for one
    // person, which is the thing this whole design is trying not to do.
    if (alreadyContactId === candidate.candidate.contactId) {
      return {
        ok: true,
        mode: options.mode,
        prospectId,
        contactId: alreadyContactId,
        alreadyPromoted: true,
        mailable: false,
        reason: `Already promoted to ${alreadyContactId}; nothing was changed.`,
      };
    }
    return {
      ok: false,
      code: 'ALREADY_PROMOTED',
      message:
        `This prospect was already promoted to contact ${alreadyContactId}, and ` +
        `${JSON.stringify(email)} derives a different contact. Promoting it again would put one ` +
        `person into the system twice. Correct the address on the existing contact instead.`,
    };
  }

  const now = options.now ?? new Date();
  const provenance: ContactProvenance = {
    source: trimmed(prospect.source) ?? 'LINKEDIN',
    sourceEvidence:
      `${trimmed(prospect.sourceEvidence) ?? 'LinkedIn'} — profile ${trimmed(prospect.profileUrl) ?? '(unrecorded)'}` +
      `; address from ${emailSource}`,
    sourceCollectedAt: trimmed(prospect.sourceCollectedAt) ?? trimmed(prospect.createdAt) ?? now.toISOString(),
    importBatchId: trimmed(prospect.importBatchId) ?? undefined,
  };

  const ingest = await ingestRecords(
    orgId,
    [
      {
        ref: prospectId,
        email: candidate.candidate.email,
        contactId: candidate.candidate.contactId,
        fields: candidate.candidate.fields,
      },
    ],
    settings,
    provenance,
    actor,
    { mode: options.mode, now }
  );

  const outcome = ingest.outcomes[0];
  const contactId = candidate.candidate.contactId;

  if (options.mode === 'COMMIT' && (outcome?.status === 'CREATED' || outcome?.status === 'DUPLICATE')) {
    await runTransaction(store, async (tx) => {
      const fresh = await tx.get(prospectRef(orgId, prospectId));
      if (!fresh.exists()) return null;
      const current = fresh.data() as Record<string, unknown>;
      // Written only after the contact exists. The link is evidence, and a link written before
      // the thing it points at would be a claim rather than a record.
      tx.set(prospectRef(orgId, prospectId), {
        ...current,
        promotedToContactId: contactId,
        promotedAt: now.toISOString(),
        promotedBy: actor,
        version: (typeof current.version === 'number' ? current.version : 0) + 1,
        updatedAt: now.toISOString(),
      });
      return null;
    });
  }

  return {
    ok: true,
    mode: options.mode,
    prospectId,
    contactId,
    alreadyPromoted: false,
    mailable: outcome?.mailable === true,
    reason: outcome?.reason ?? 'The ingest returned no outcome for this record.',
  };
}

export interface ProspectListOptions {
  readonly limit?: number;
  /** Omit for all; `false` for the ones still waiting on an address. */
  readonly promoted?: boolean;
}

/** Read prospects, newest first. A read: nothing here writes. */
export async function listProspects(
  orgId: string,
  options: ProspectListOptions = {}
): Promise<Record<string, unknown>[]> {
  if (!store) return [];
  const cap = Math.max(1, Math.min(options.limit ?? 200, MAX_PROSPECT_BATCH));
  const snap = await getDocs(
    query(collection(store, orgPath(orgId, 'prospects')), orderBy('createdAt', 'desc'), limitTo(cap))
  );
  const rows = snap.docs.map((d) => d.data() as Record<string, unknown>);
  if (options.promoted === undefined) return rows;
  return rows.filter((r) => (trimmed(r.promotedToContactId) !== null) === options.promoted);
}
