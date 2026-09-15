import { fetchWithTimeout } from '../lib/httpClient';
import { classifyThrown, ProviderError } from '../lib/providerError';
import { checkCrawlTarget } from '../domain/crawlTarget';
import type { DiscoverOutput, DiscoveredRecord, DiscoveryProvider, DiscoveryQuery } from './types';

/**
 * A REAL DISCOVERY ADAPTER, CONFIGURED RATHER THAN HARDCODED.
 *
 * WHY IT IS NOT WRITTEN AGAINST A NAMED VENDOR
 * --------------------------------------------
 * `discovery.service.ts` shipped with no adapter and said so honestly: "writing one against an
 * API nobody has bought would be code whose behaviour nothing could check." That argument is
 * still right about a vendor-specific client — the request shape, the pagination, the error
 * envelope and the billing semantics all differ, and inventing them produces a file that
 * compiles and cannot work.
 *
 * What it is NOT right about is the shape every one of those vendors shares: an HTTPS endpoint,
 * a bearer credential, a JSON body of query filters, and an array of records somewhere in the
 * response. That is checkable, and this adapter implements it. Pointing it at a provider is
 * configuration — a URL, a key, and a map from their field names to ours — rather than a code
 * change, which is what makes the difference between "no adapter ships" and "no vendor is
 * chosen".
 *
 * WHAT THE CONFIGURATION CANNOT DO
 * --------------------------------
 * It cannot widen what this system accepts. The field map chooses which of THEIR keys fills
 * each of OUR fields, and our fields are a fixed list; a map naming anything else is refused at
 * load. So a misconfigured or hostile config still cannot introduce `consentGiven`,
 * `suppressed` or `lawfulBasis` into a record — the mass-assignment defence is in the shape of
 * the mapping, not in the care taken writing it.
 *
 * EVERYTHING THE ENDPOINT RETURNS IS UNTRUSTED (§18)
 * --------------------------------------------------
 * The response body is a stranger's JSON. It is size-bounded before parsing, record-count
 * bounded after, every extracted value is coerced to a bounded string, and the whole lot then
 * goes through `validateCandidate` in the calling service — the same validator the CSV importer
 * uses. Nothing here treats a provider's opinion as authority, including its opinion that a
 * record is "verified" or "opted in", which this adapter does not even read.
 *
 * THE BASE URL IS SSRF-CHECKED (§18)
 * ----------------------------------
 * Using the same `checkCrawlTarget` the scraper uses, and for the same reason: a configured URL
 * is still an input, and an operator who pastes `http://169.254.169.254/...` into an
 * environment variable should get a refusal rather than the cloud metadata service. HTTPS is
 * additionally required here, which the crawler cannot require of the open web but a paid API
 * endpoint must satisfy.
 */

/** The only fields a provider may fill. Mirrors `DiscoveredRecord` minus the id. */
export const MAPPABLE_FIELDS = [
  'email',
  'firstName',
  'lastName',
  'title',
  'companyName',
  'companyWebsite',
  'industry',
  'country',
  'employeeCount',
  'linkedinUrl',
  'sourceUrl',
] as const;

export type MappableField = (typeof MAPPABLE_FIELDS)[number];

/** Filters this adapter knows how to put in a request body. */
export const MAPPABLE_FILTERS: readonly (keyof DiscoveryQuery)[] = [
  'country',
  'industry',
  'titles',
  'companySizeMin',
  'companySizeMax',
  'limit',
];

/** Response bodies above this are refused unparsed. A lookup is not a bulk download. */
export const MAX_DISCOVERY_BYTES = 4_000_000;

/** However many the provider sends, no more than this reach the ingest. */
export const MAX_DISCOVERY_RECORDS = 1_000;

/** Bound on any single extracted value, matching the candidate validator's own limit. */
export const MAX_DISCOVERY_FIELD = 500;

export const DISCOVERY_TIMEOUT_MS = 30_000;

export interface HttpDiscoveryConfig {
  readonly providerName: string;
  readonly endpoint: string;
  readonly apiKey: string;
  readonly authHeader: string;
  /** Prefix for the credential: "Bearer", "Token", or empty for a bare key. */
  readonly authScheme: string;
  /** Dot path to the records array in the response body: `data.people`. */
  readonly recordsPath: string;
  /** Dot path to the provider's id for each record. Required: we never mint one. */
  readonly recordIdPath: string;
  /** Our field name to their dot path. Only `MAPPABLE_FIELDS` keys are permitted. */
  readonly fieldMap: Readonly<Record<string, string>>;
  /** Dot path to what the lookup cost, in USD cents. Absent means the ceiling is used. */
  readonly costMinorPath: string | null;
  /** Charged to the tenant when the provider does not report a cost. */
  readonly costCeilingMinor: number;
  /** Dot path to the provider's id for the whole lookup. Absent means one is derived. */
  readonly queryIdPath: string | null;
  readonly supportedFilters: readonly (keyof DiscoveryQuery)[];
}

export type ConfigRefusalCode =
  | 'NOT_CONFIGURED'
  | 'BAD_ENDPOINT'
  | 'BAD_FIELD_MAP'
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_FILTER'
  | 'NO_EMAIL_MAPPING'
  | 'BAD_COST_CEILING';

export type ConfigOutcome =
  | { readonly ok: true; readonly config: HttpDiscoveryConfig }
  | { readonly ok: false; readonly code: ConfigRefusalCode; readonly message: string };

function env(name: string): string {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read the adapter's configuration from the environment.
 *
 * NO SECRET VALUE APPEARS IN ANY MESSAGE THIS FUNCTION RETURNS. A configuration error is
 * reported by naming the variable, never by quoting it: an error string reaches logs, and a
 * refusal that helpfully echoes the API key it could not parse has published the key.
 */
export function readHttpDiscoveryConfig(
  resolve: (raw: string) => { ok: boolean; code?: string; message?: string } = (raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' ? { ok: true } : { ok: false, code: 'BAD_SCHEME', message: 'not https' };
    } catch {
      return { ok: false, code: 'BAD_URL', message: 'unparseable' };
    }
  }
): ConfigOutcome {
  const providerName = env('DISCOVERY_PROVIDER_NAME');
  const endpoint = env('DISCOVERY_ENDPOINT');
  const apiKey = env('DISCOVERY_API_KEY');

  if (providerName === '' || endpoint === '' || apiKey === '') {
    const absent = [
      providerName === '' ? 'DISCOVERY_PROVIDER_NAME' : null,
      endpoint === '' ? 'DISCOVERY_ENDPOINT' : null,
      apiKey === '' ? 'DISCOVERY_API_KEY' : null,
    ].filter(Boolean);
    return {
      ok: false,
      code: 'NOT_CONFIGURED',
      message:
        `No discovery provider is configured: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} ` +
        `not set. This is the ordinary state, not an error — the adapter exists so that choosing ` +
        `a vendor is configuration, and no vendor has been chosen.`,
    };
  }

  const urlCheck = resolve(endpoint);
  if (!urlCheck.ok) {
    return {
      ok: false,
      code: 'BAD_ENDPOINT',
      message:
        `DISCOVERY_ENDPOINT is not a usable HTTPS endpoint (${urlCheck.code}: ${urlCheck.message}). ` +
        `A configured URL is still an input: it is checked against the same private-address and ` +
        `scheme rules the scraper uses, so a metadata-service address in an environment variable ` +
        `refuses rather than resolving.`,
    };
  }

  const rawMap = env('DISCOVERY_FIELD_MAP');
  let parsed: unknown;
  try {
    parsed = rawMap === '' ? {} : JSON.parse(rawMap);
  } catch {
    return {
      ok: false,
      code: 'BAD_FIELD_MAP',
      message: 'DISCOVERY_FIELD_MAP is not valid JSON. It maps our field names to dot paths in the provider response.',
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      code: 'BAD_FIELD_MAP',
      message: 'DISCOVERY_FIELD_MAP must be a JSON object of our field name to their dot path.',
    };
  }

  const fieldMap: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(MAPPABLE_FIELDS as readonly string[]).includes(ours)) {
      return {
        ok: false,
        code: 'UNKNOWN_FIELD',
        message:
          `DISCOVERY_FIELD_MAP names ${JSON.stringify(ours)}, which is not a field a provider may ` +
          `fill. The permitted set is ${MAPPABLE_FIELDS.join(', ')} — deliberately excluding ` +
          `consent, suppression and lawful basis, none of which an external source gets to assert.`,
      };
    }
    if (typeof theirs !== 'string' || theirs.trim() === '') {
      return {
        ok: false,
        code: 'BAD_FIELD_MAP',
        message: `DISCOVERY_FIELD_MAP entry for ${JSON.stringify(ours)} is not a non-empty dot path.`,
      };
    }
    fieldMap[ours] = theirs.trim();
  }

  if (fieldMap.email === undefined) {
    return {
      ok: false,
      code: 'NO_EMAIL_MAPPING',
      message:
        'DISCOVERY_FIELD_MAP has no `email` entry. The address is the identity key for a contact, ' +
        'so a provider that cannot supply one supplies nothing this system can store.',
    };
  }

  const filtersRaw = env('DISCOVERY_SUPPORTED_FILTERS');
  const filters = filtersRaw === '' ? ['country', 'limit'] : filtersRaw.split(',').map((f) => f.trim()).filter(Boolean);
  for (const filter of filters) {
    if (!(MAPPABLE_FILTERS as readonly string[]).includes(filter)) {
      return {
        ok: false,
        code: 'UNKNOWN_FILTER',
        message:
          `DISCOVERY_SUPPORTED_FILTERS names ${JSON.stringify(filter)}, which this adapter cannot ` +
          `put in a request. Declaring a filter it will silently drop is worse than declaring ` +
          `none: the service refuses an unsupported filter before spending money, and that ` +
          `refusal is only correct if this list is honest.`,
      };
    }
  }

  const ceilingRaw = env('DISCOVERY_COST_CEILING_MINOR');
  const costCeilingMinor = ceilingRaw === '' ? 500 : Number(ceilingRaw);
  if (!Number.isInteger(costCeilingMinor) || costCeilingMinor < 0) {
    return {
      ok: false,
      code: 'BAD_COST_CEILING',
      message: `DISCOVERY_COST_CEILING_MINOR must be a non-negative whole number of cents.`,
    };
  }

  return {
    ok: true,
    config: {
      providerName,
      endpoint,
      apiKey,
      authHeader: env('DISCOVERY_AUTH_HEADER') || 'Authorization',
      authScheme: env('DISCOVERY_AUTH_SCHEME') || 'Bearer',
      recordsPath: env('DISCOVERY_RECORDS_PATH') || 'records',
      recordIdPath: env('DISCOVERY_RECORD_ID_PATH') || 'id',
      fieldMap: Object.freeze(fieldMap),
      costMinorPath: env('DISCOVERY_COST_MINOR_PATH') || null,
      costCeilingMinor,
      queryIdPath: env('DISCOVERY_QUERY_ID_PATH') || null,
      supportedFilters: Object.freeze(filters as (keyof DiscoveryQuery)[]),
    },
  };
}

/**
 * Follow a dot path into a parsed body.
 *
 * Returns `undefined` for anything that is not there, and never throws: this walks a stranger's
 * JSON, where a missing key, a null in the middle and an array where an object was expected are
 * all ordinary. Prototype keys are refused outright — a path of `__proto__.x` against a parsed
 * body is a reach for something the response does not contain.
 */
export function atPath(body: unknown, path: string): unknown {
  const segments = path.split('.').filter((s) => s !== '');
  let cursor: unknown = body;
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') return undefined;
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Coerce a value from a provider into a bounded string, or undefined.
 *
 * Numbers and booleans are accepted because `employeeCount: 42` is a reasonable thing for an
 * API to send. Objects and arrays are not: `[object Object]` in a company name is a bug wearing
 * a value's clothing.
 */
function asField(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed.slice(0, MAX_DISCOVERY_FIELD);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** Turn one item of the provider's array into a record, or null when it has no usable id. */
export function mapRecord(raw: unknown, config: HttpDiscoveryConfig): DiscoveredRecord | null {
  if (raw === null || typeof raw !== 'object') return null;
  const providerRecordId = asField(atPath(raw, config.recordIdPath));
  if (providerRecordId === undefined) {
    // No provider id means no way to say which record a refusal refers to, and no way to tell a
    // record we received twice from two records. Dropped rather than given one of ours: a
    // locally minted id recorded as the provider's is the P0.8 defect in a different costume.
    return null;
  }
  const record: Record<string, unknown> = { providerRecordId };
  for (const field of MAPPABLE_FIELDS) {
    const path = config.fieldMap[field];
    if (path === undefined) continue;
    const value = asField(atPath(raw, path));
    if (value !== undefined) record[field] = value;
  }
  return typeof record.email === 'string' ? (record as unknown as DiscoveredRecord) : null;
}

/** Build the request body from the filters this provider declared it supports. */
export function requestBodyFor(query: DiscoveryQuery, config: HttpDiscoveryConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const filter of config.supportedFilters) {
    const value = query[filter];
    if (value === undefined) continue;
    body[filter] = value;
  }
  return body;
}

/**
 * The adapter.
 *
 * Constructed from a validated config, so an instance that exists is one whose endpoint, field
 * map and filter list have already been checked. There is no path that builds one from raw
 * environment strings.
 */
export class HttpDiscoveryProvider implements DiscoveryProvider {
  readonly providerName: string;
  readonly requiredCapabilities = [] as const;
  readonly supportedFilters: readonly (keyof DiscoveryQuery)[];

  constructor(private readonly config: HttpDiscoveryConfig) {
    this.providerName = config.providerName;
    this.supportedFilters = config.supportedFilters;
  }

  async discover(input: DiscoveryQuery): Promise<DiscoverOutput> {
    let response: Response;
    try {
      response = await fetchWithTimeout(this.config.endpoint, {
        method: 'POST',
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          [this.config.authHeader]:
            this.config.authScheme === '' ? this.config.apiKey : `${this.config.authScheme} ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBodyFor(input, this.config)),
      });
    } catch (e) {
      // A throw here is a transport failure, and whether the provider ran and charged for the
      // query is exactly what nobody can tell. `classifyThrown` carries that distinction; the
      // discovery service reads it and records the spend ceiling rather than retrying (§32).
      throw classifyThrown(e, { provider: this.providerName, operation: 'discover' });
    }

    if (!response.ok) {
      throw new ProviderError({
        provider: this.providerName,
        operation: 'discover',
        kind:
          response.status === 401
            ? 'UNAUTHENTICATED'
            : response.status === 403
              ? 'PERMISSION_DENIED'
              : response.status === 429
                ? 'RATE_LIMITED'
                : response.status >= 500
                  ? 'PROVIDER_UNAVAILABLE'
                  : 'INVALID_REQUEST',
        signal: `HTTP ${response.status}`,
        status: response.status,
      });
    }

    const raw = await response.text();
    if (raw.length > MAX_DISCOVERY_BYTES) {
      throw new ProviderError({
        provider: this.providerName,
        operation: 'discover',
        // UNKNOWN, WHICH IS AMBIGUOUS, AND THAT IS THE POINT. A body came back, so the
        // provider ran the query and in all likelihood charged for it — we simply cannot read
        // what it sent. `INVALID_REQUEST` would classify this as NOT_APPLIED and the service
        // would record no spend and permit an immediate retry, which is how a capped budget
        // gets spent twice over. AMBIGUOUS records the ceiling and refuses (§32).
        kind: 'UNKNOWN',
        signal: `response was ${raw.length} bytes, above the ${MAX_DISCOVERY_BYTES} limit`,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ProviderError({
        provider: this.providerName,
        operation: 'discover',
        kind: 'UNKNOWN',
        signal: 'response was not JSON',
      });
    }

    const list = atPath(body, this.config.recordsPath);
    if (!Array.isArray(list)) {
      throw new ProviderError({
        provider: this.providerName,
        operation: 'discover',
        kind: 'UNKNOWN',
        signal: `no array at ${this.config.recordsPath}`,
      });
    }

    const records: DiscoveredRecord[] = [];
    for (const item of list.slice(0, MAX_DISCOVERY_RECORDS)) {
      const mapped = mapRecord(item, this.config);
      if (mapped !== null) records.push(mapped);
    }

    // A provider that ignores `limit` has broken its contract, and the service bills per record
    // ingested — so the cap is enforced here rather than trusted. Truncating is the safe
    // direction: the alternative is ingesting ten thousand records from a query for fifty.
    const capped = records.slice(0, Math.max(0, Math.min(input.limit, MAX_DISCOVERY_RECORDS)));

    const reportedCost = this.config.costMinorPath === null ? undefined : atPath(body, this.config.costMinorPath);
    const costMinor =
      typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0
        ? Math.round(reportedCost)
        : this.config.costCeilingMinor;
    const costIsUpperBound = !(typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0);

    const reportedQueryId = this.config.queryIdPath === null ? undefined : asField(atPath(body, this.config.queryIdPath));

    return {
      records: capped,
      costMinor,
      costIsUpperBound,
      // Falls back to a digest of the request rather than to a clock: two lookups with the same
      // filters are the same query, and a timestamp would make every one of them unique and the
      // batch id meaningless.
      queryId: reportedQueryId ?? `q_${hashOf(JSON.stringify(requestBodyFor(input, this.config)))}`,
    };
  }
}

/** A short, stable, non-cryptographic digest. Used only to name a query, never as a secret. */
function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build the adapter from the environment, or say why not.
 *
 * `server.ts` calls this at startup and registers the result. The unconfigured case returns a
 * refusal rather than throwing, because "no vendor chosen" is the ordinary state of this
 * system and a startup crash would be the wrong way to say so.
 */
export async function buildConfiguredDiscoveryProvider(): Promise<
  { readonly ok: true; readonly provider: HttpDiscoveryProvider } | { readonly ok: false; readonly code: ConfigRefusalCode; readonly message: string }
> {
  // The endpoint is SSRF-checked with a real DNS resolution, which is why this is async and why
  // the pure `readHttpDiscoveryConfig` takes the check as a parameter: the config rules stay
  // exercisable without a network.
  const outcome = readHttpDiscoveryConfig((raw) => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') return { ok: false, code: 'BAD_SCHEME', message: 'a paid API endpoint must be https' };
      return { ok: true };
    } catch {
      return { ok: false, code: 'BAD_URL', message: 'unparseable URL' };
    }
  });
  if (!outcome.ok) return outcome;

  const target = await checkCrawlTarget(outcome.config.endpoint);
  if (!target.ok) {
    return {
      ok: false,
      code: 'BAD_ENDPOINT',
      message:
        `DISCOVERY_ENDPOINT resolves to an address this system will not call ` +
        `(${target.code}: ${target.message}).`,
    };
  }

  return { ok: true, provider: new HttpDiscoveryProvider(outcome.config) };
}
