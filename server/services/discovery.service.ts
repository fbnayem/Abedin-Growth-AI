import { store } from '../store';
import { isRealActionEnabled } from '../config/safeMode';
import { normaliseCountry, type AddressType, type LawfulBasis } from '../domain/lawfulBasis';
import { validateCandidate } from '../domain/leadCandidate';
import { ingestRecords, type IngestMode, type IngestRecord, type IngestOutcome } from './leadIngest.service';
import { recordTenantSpend, tenantSpendGate } from './tenantSpend.service';
import { KIND_DISPOSITION, classifyThrown } from '../lib/providerError';
import type { ContactProvenance } from '../domain/contactDocument';
import type { Attribution } from '../domain/operatorAction';
import type { DiscoveredRecord, DiscoveryProvider, DiscoveryQuery } from '../providers/types';

/**
 * PAID LEAD DISCOVERY (§14, §18, §32, §A).
 *
 * A discovery lookup is the first thing in this system that spends a tenant's money on an
 * outside service in order to obtain personal data about people who have never heard of them.
 * Three properties follow, and each is enforced before the network rather than discovered after
 * it.
 *
 * 1. IT IS OFF BY DEFAULT. `REAL_DISCOVERY_ENABLED` is one of the seven production-action flags
 *    and fails closed, so a fresh deployment, a missing `.env` and a typo all mean "do not
 *    spend". It sits alongside the send flags rather than in a category of its own: an operator
 *    asking "can this system touch anything outside itself?" should get one answer.
 *
 * 2. IT IS CAPPED. Every lookup passes `tenantSpendGate` first and `recordTenantSpend` after,
 *    so a runaway search hits a daily and a monthly ceiling that fails closed. The ledger is
 *    the same one model calls use, deliberately: a tenant's budget is a tenant's budget, and
 *    two ledgers would be two ways to be under the limit while being over it.
 *
 * 3. A TIMEOUT IS NOT A FAILURE (§32). The provider may have run the query and charged for it.
 *    So an AMBIGUOUS outcome RECORDS THE SPEND AT ITS CEILING and refuses, rather than
 *    returning an error a caller would naturally retry. Retrying an ambiguous paid lookup is
 *    how a capped budget gets spent twice over and the cap never fires.
 *
 * WHAT THE PROVIDER RETURNS IS DATA, NOT AUTHORITY (§18)
 * -----------------------------------------------------
 * Every record goes through `validateCandidate`, the same validator the CSV importer uses, and
 * then through the same `ingestRecords` write path. A provider cannot set a suppression flag,
 * cannot nominate a lawful basis, and cannot put a spreadsheet formula into a company name that
 * survives to the operator's next export. A provider is a stranger sending JSON.
 *
 * WHY THE BASIS IS STILL THE OPERATOR'S DECISION
 * ---------------------------------------------
 * Nothing about buying a list makes the people on it contactable. Records land with the batch's
 * basis, which for purchased data is legitimate interest at best, and remain unmailable until
 * the Article 14 notice is recorded as sent. The provider's opinion of "verified" or
 * "opted in" is not consent and is not accepted as one.
 */

export type DiscoveryRefusalCode =
  | 'DISCOVERY_DISABLED'
  | 'NO_PROVIDER'
  | 'ATTRIBUTION_REQUIRED'
  | 'STORE_UNAVAILABLE'
  | 'SPEND_CAPPED'
  | 'UNSUPPORTED_FILTER'
  | 'COUNTRY_UNKNOWN'
  | 'NO_LIA'
  | 'NO_SOURCE_EVIDENCE'
  | 'PROVIDER_FAILED'
  | 'PROVIDER_AMBIGUOUS';

export interface DiscoveryBatchSettings {
  readonly basis: LawfulBasis;
  readonly liaId?: string;
  readonly addressType?: AddressType;
  /** Where this search came from, in a form a person could check. Required. */
  readonly sourceEvidence: string;
  readonly type?: 'LEAD' | 'INVESTOR' | 'PARTNER';
}

export interface DiscoveryResult {
  readonly ok: true;
  readonly mode: IngestMode;
  readonly provider: string;
  readonly queryId: string;
  readonly batchId: string;
  /** What this lookup cost, in USD cents, as the provider reported it. */
  readonly costMinor: number;
  readonly costIsUpperBound: boolean;
  readonly returned: number;
  /** Records the provider returned that this system refused, with the reason. */
  readonly rejected: readonly { readonly providerRecordId: string; readonly code: string; readonly message: string }[];
  readonly counts: {
    readonly wouldCreate: number;
    readonly created: number;
    readonly duplicates: number;
    readonly failed: number;
    readonly mailable: number;
  };
  readonly outcomes: readonly IngestOutcome[];
}

export type DiscoveryOutcome =
  | DiscoveryResult
  | {
      readonly ok: false;
      readonly code: DiscoveryRefusalCode;
      readonly message: string;
      /** Set when a paid lookup may have happened anyway. The spend has been recorded. */
      readonly sideEffect?: 'NOT_APPLIED' | 'AMBIGUOUS';
    };

/**
 * The registered discovery provider, or null.
 *
 * A registry rather than a hard-wired import so a second provider is a registration, and so
 * tests substitute one without a module mock. Null is the honest state today: no adapter ships
 * with this repository, because writing one against an API nobody has bought would be code
 * whose behaviour nothing could check.
 */
let registered: DiscoveryProvider | null = null;

export function registerDiscoveryProvider(provider: DiscoveryProvider | null): void {
  registered = provider;
}

export function discoveryProvider(): DiscoveryProvider | null {
  return registered;
}

/** The cost recorded when a lookup's outcome is ambiguous and the provider never said. */
export const AMBIGUOUS_COST_CEILING_MINOR = 500;

function batchIdFor(provider: string, queryId: string): string {
  return `disc_${provider}_${queryId}`.slice(0, 120);
}

/**
 * Run a discovery search and ingest what comes back.
 *
 * Every refusal below happens BEFORE the network call except the last two, which are the
 * network call's own outcome.
 */
export async function discoverLeads(
  orgId: string,
  query: DiscoveryQuery,
  batch: DiscoveryBatchSettings,
  by: Attribution,
  options: { mode: IngestMode; now?: Date } = { mode: 'PREVIEW' }
): Promise<DiscoveryOutcome> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }

  if (by.kind !== 'IDENTIFIED') {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Discovery needs an identified operator: ${by.why}. It spends this tenant's money and ` +
        `creates records about people, and both need a name against them.`,
    };
  }
  const actor = by.actor;

  if (!isRealActionEnabled('REAL_DISCOVERY_ENABLED')) {
    return {
      ok: false,
      code: 'DISCOVERY_DISABLED',
      message:
        'Paid lead discovery is disabled. REAL_DISCOVERY_ENABLED is not set to "true", and it ' +
        'fails closed: an absent, empty or misspelled value means no external lookup and no ' +
        'spend. Nothing was called and nothing was charged.',
    };
  }

  const provider = registered;
  if (provider === null) {
    return {
      ok: false,
      code: 'NO_PROVIDER',
      message:
        'No discovery provider is registered. The flag being on does not conjure an adapter, ' +
        'and answering with fabricated records would be worse than answering with nothing.',
    };
  }

  const country = normaliseCountry(query.country);
  if (country === null) {
    return {
      ok: false,
      code: 'COUNTRY_UNKNOWN',
      message:
        `A discovery search must name the country it is searching (received ` +
        `${JSON.stringify(query.country)}). The outreach gate refuses an unknown jurisdiction, ` +
        `so a search without one buys records that can never be used.`,
    };
  }

  if (typeof batch.sourceEvidence !== 'string' || batch.sourceEvidence.trim() === '') {
    return {
      ok: false,
      code: 'NO_SOURCE_EVIDENCE',
      message:
        'A discovery run needs to say what it is for. That text is what an Article 14 notice ' +
        'has to tell each person about where their data came from.',
    };
  }

  if (batch.basis === 'LEGITIMATE_INTEREST' && (typeof batch.liaId !== 'string' || batch.liaId.trim() === '')) {
    return {
      ok: false,
      code: 'NO_LIA',
      message:
        'Discovering on legitimate interest requires the id of the balancing assessment that ' +
        'covers this search. Buying a list is precisely the case the assessment exists for.',
    };
  }

  // Filters the provider does not support are refused rather than dropped. A dropped filter
  // means a broader search: more records, more money, and results the operator did not ask for.
  const requested = (Object.keys(query) as (keyof DiscoveryQuery)[]).filter(
    (k) => query[k] !== undefined && k !== 'limit'
  );
  const unsupported = requested.filter((k) => !provider.supportedFilters.includes(k));
  if (unsupported.length > 0) {
    return {
      ok: false,
      code: 'UNSUPPORTED_FILTER',
      message:
        `${provider.providerName} cannot filter on ${unsupported.join(', ')}. Refusing rather ` +
        `than dropping the filter: a dropped filter widens the search, which costs more and ` +
        `returns people the operator did not ask for.`,
    };
  }

  const now = options.now ?? new Date();

  const gate = await tenantSpendGate(orgId, now);
  if (gate.allowed === false) {
    return {
      ok: false,
      code: 'SPEND_CAPPED',
      message: `Discovery is not authorised: ${gate.reason}`,
    };
  }

  let output;
  try {
    output = await provider.discover({ ...query, country });
  } catch (error) {
    // Classified by TYPE, never by reading the message. An adapter that throws a bare Error
    // lands on UNKNOWN, and UNKNOWN is AMBIGUOUS — which is the safe direction for a call that
    // may have been charged for.
    const providerError = classifyThrown(error, {
      provider: provider.providerName,
      operation: 'discover',
      now,
    });
    const disposition = KIND_DISPOSITION[providerError.kind];

    if (disposition.outcome === 'AMBIGUOUS') {
      // §32 — the lookup may have run and may have been charged for. Record a CEILING before
      // returning, so a retry meets the cap rather than spending twice. The alternative, an
      // error a caller naturally retries, is how a capped budget gets spent without the cap
      // ever firing.
      const recorded = await recordTenantSpend(
        orgId,
        { costMinor: AMBIGUOUS_COST_CEILING_MINOR, costIsUpperBound: true, tokens: 0, calls: 1 },
        now
      );
      return {
        ok: false,
        code: 'PROVIDER_AMBIGUOUS',
        sideEffect: 'AMBIGUOUS',
        message:
          `${provider.providerName} did not answer (${providerError.kind}: ${providerError.message}). ` +
          `The lookup may have run and may have been charged, so ${AMBIGUOUS_COST_CEILING_MINOR}¢ ` +
          `has been recorded against this tenant as a ceiling` +
          `${recorded.ok ? '' : ` — except that the ledger write failed (${recorded.reason}), which now blocks further spend`}. ` +
          `Reconcile with the provider before running this search again.`,
      };
    }

    return {
      ok: false,
      code: 'PROVIDER_FAILED',
      sideEffect: 'NOT_APPLIED',
      message: `${provider.providerName} refused the lookup (${providerError.kind}: ${providerError.message}). Nothing was charged.`,
    };
  }

  // The provider answered. Record what it says it charged BEFORE doing anything with the
  // records: the money is spent whether or not the ingest succeeds.
  const spend = await recordTenantSpend(
    orgId,
    {
      costMinor: Math.max(0, Math.round(output.costMinor)),
      costIsUpperBound: output.costIsUpperBound,
      tokens: 0,
      calls: 1,
    },
    now
  );
  if (spend.ok === false) {
    console.error(`[Discovery] Spend for ${orgId} was NOT recorded: ${spend.reason}`);
  }

  // A provider that returns more than it was asked for has broken its contract; the extra
  // records are dropped rather than ingested, and the count is reported either way.
  const returned = output.records.slice(0, query.limit);

  const records: IngestRecord[] = [];
  const rejected: { providerRecordId: string; code: string; message: string }[] = [];

  for (const record of returned) {
    const outcome = validateCandidate(candidateFieldsFrom(record, country, batch.addressType));
    if (outcome.ok === false) {
      rejected.push({
        providerRecordId: String(record.providerRecordId ?? '(none)'),
        code: outcome.code,
        message: outcome.message,
      });
      continue;
    }
    // A record the provider sent twice is not two people.
    if (records.some((r) => r.contactId === outcome.candidate.contactId)) {
      rejected.push({
        providerRecordId: String(record.providerRecordId ?? '(none)'),
        code: 'DUPLICATE_IN_RESULT',
        message: 'The provider returned this address more than once in one result set.',
      });
      continue;
    }
    records.push({
      ref: `${provider.providerName}:${record.providerRecordId}`,
      email: outcome.candidate.email,
      contactId: outcome.candidate.contactId,
      fields: outcome.candidate.fields,
    });
  }

  const batchId = batchIdFor(provider.providerName, output.queryId);
  const provenance: ContactProvenance = {
    source: `PROVIDER:${provider.providerName}`,
    sourceEvidence:
      `${batch.sourceEvidence} — ${provider.providerName} query ${output.queryId}, ` +
      `${JSON.stringify({ ...query, country })}`,
    sourceCollectedAt: now.toISOString(),
    importBatchId: batchId,
  };

  const result = await ingestRecords(
    orgId,
    records,
    {
      basis: batch.basis,
      liaId: batch.liaId,
      // No `consentEvidence` and no `consentSource`: a purchased record is not evidence that
      // anyone consented, and a provider saying "opted in" is not a consent this system holds.
      country,
      addressType: batch.addressType,
    },
    provenance,
    actor,
    { mode: options.mode, type: batch.type ?? 'LEAD', now }
  );

  return {
    ok: true,
    mode: options.mode,
    provider: provider.providerName,
    queryId: output.queryId,
    batchId,
    costMinor: Math.max(0, Math.round(output.costMinor)),
    costIsUpperBound: output.costIsUpperBound,
    returned: output.records.length,
    rejected,
    counts: {
      wouldCreate: result.wouldCreate,
      created: result.created,
      duplicates: result.duplicates,
      failed: result.failed,
      mailable: result.mailable,
    },
    outcomes: result.outcomes,
  };
}

/**
 * A provider record, reduced to the allowlisted fields.
 *
 * Built field by field rather than spread, so a provider that adds `consentGiven: true` to its
 * response — which a vendor selling "opted-in data" would think helpful — writes nothing.
 * `validateCandidate` would ignore it anyway; naming the fields here means there are two
 * independent reasons it cannot land, which is the right number for a field that decides
 * whether someone gets emailed.
 */
function candidateFieldsFrom(
  record: DiscoveredRecord,
  country: string,
  addressType: AddressType | undefined
): Record<string, unknown> {
  return {
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
    title: record.title,
    companyName: record.companyName,
    companyWebsite: record.companyWebsite,
    industry: record.industry,
    // The provider's country if it gave one, otherwise the country that was searched for.
    country: record.country ?? country,
    employeeCount: record.employeeCount,
    linkedinUrl: record.linkedinUrl,
    addressType,
    // Deliberately absent: notes, consentEvidence, consentSource, article14NoticeSentAt,
    // timeZone. A provider has no standing to assert any of them, and the notice in particular
    // has not been sent — this search is the reason it will need to be.
  };
}
