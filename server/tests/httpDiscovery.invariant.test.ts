import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  HttpDiscoveryProvider,
  MAPPABLE_FIELDS,
  MAX_DISCOVERY_BYTES,
  atPath,
  mapRecord,
  readHttpDiscoveryConfig,
  requestBodyFor,
  type HttpDiscoveryConfig,
} from '../providers/httpDiscovery.provider';
import { ProviderError, KIND_DISPOSITION } from '../lib/providerError';

/**
 * THE DISCOVERY ADAPTER (§18, §32, §A).
 *
 * `discovery.service.ts` shipped with no adapter, and the argument for that was sound about a
 * VENDOR-SPECIFIC client: request shapes, pagination and billing all differ, and inventing them
 * produces a file that compiles and cannot work. It was not sound about the shape every vendor
 * shares — an HTTPS endpoint, a bearer credential, a JSON body, an array of records — which is
 * checkable, and which this adapter implements.
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 * 1. CONFIGURATION CANNOT WIDEN WHAT THE SYSTEM ACCEPTS. The field map chooses which of THEIR
 *    keys fill OUR fields, and our fields are a fixed list. A map naming `consentGiven` is
 *    refused at load, so the mass-assignment defence is in the SHAPE of the mapping rather than
 *    in the care taken writing it.
 * 2. THE RESPONSE IS A STRANGER'S JSON. Size-bounded before parsing, count-bounded after, every
 *    value coerced, missing keys yielding undefined rather than throwing, and `__proto__`
 *    refused as a path segment.
 * 3. NO ID IS EVER MINTED. A record with no provider id is dropped, not given one of ours —
 *    P0.8 in a different costume.
 * 4. AN UNREADABLE RESPONSE IS AMBIGUOUS, NOT A CLEAN FAILURE (§32). Bytes came back, so the
 *    provider ran the query and probably charged. Classifying it as NOT_APPLIED would record no
 *    spend and licence an immediate retry, which is how a capped budget is spent twice over.
 * 5. NO SECRET APPEARS IN ANY MESSAGE. Config errors name variables, never values.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const SECRET = 'sk-live-do-not-print-me-123456';

const ENV_KEYS = [
  'DISCOVERY_PROVIDER_NAME',
  'DISCOVERY_ENDPOINT',
  'DISCOVERY_API_KEY',
  'DISCOVERY_AUTH_HEADER',
  'DISCOVERY_AUTH_SCHEME',
  'DISCOVERY_RECORDS_PATH',
  'DISCOVERY_RECORD_ID_PATH',
  'DISCOVERY_FIELD_MAP',
  'DISCOVERY_COST_MINOR_PATH',
  'DISCOVERY_COST_CEILING_MINOR',
  'DISCOVERY_QUERY_ID_PATH',
  'DISCOVERY_SUPPORTED_FILTERS',
];

const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string>) {
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

const GOOD_ENV = {
  DISCOVERY_PROVIDER_NAME: 'acme-data',
  DISCOVERY_ENDPOINT: 'https://api.acme-data.example/v1/search',
  DISCOVERY_API_KEY: SECRET,
  DISCOVERY_RECORDS_PATH: 'data.people',
  DISCOVERY_RECORD_ID_PATH: 'person_id',
  DISCOVERY_FIELD_MAP: JSON.stringify({
    email: 'contact.email',
    firstName: 'name.first',
    companyName: 'org.name',
    country: 'org.country',
    employeeCount: 'org.size',
  }),
  DISCOVERY_COST_MINOR_PATH: 'billing.cents',
  DISCOVERY_QUERY_ID_PATH: 'request_id',
  DISCOVERY_SUPPORTED_FILTERS: 'country,industry,limit',
};

/** A config object without going through the environment. */
function config(overrides: Partial<HttpDiscoveryConfig> = {}): HttpDiscoveryConfig {
  return {
    providerName: 'acme-data',
    endpoint: 'https://api.acme-data.example/v1/search',
    apiKey: SECRET,
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    recordsPath: 'data.people',
    recordIdPath: 'person_id',
    fieldMap: { email: 'contact.email', companyName: 'org.name' },
    costMinorPath: 'billing.cents',
    costCeilingMinor: 500,
    queryIdPath: 'request_id',
    supportedFilters: ['country', 'limit'],
    ...overrides,
  };
}

/** Replace global fetch with a canned response. Restored after every test. */
let realFetch: typeof globalThis.fetch;
function stubFetch(handler: () => Promise<Response> | Response | never) {
  globalThis.fetch = (async () => handler()) as unknown as typeof globalThis.fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  realFetch = globalThis.fetch;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  globalThis.fetch = realFetch;
});

describe('1. an unconfigured deployment says so, and is not an error', () => {
  it('reports NOT_CONFIGURED and names every variable that is absent', () => {
    setEnv({});
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('NOT_CONFIGURED');
    for (const name of ['DISCOVERY_PROVIDER_NAME', 'DISCOVERY_ENDPOINT', 'DISCOVERY_API_KEY']) {
      expect(outcome.message).toContain(name);
    }
    expect(outcome.message).toContain('ordinary state');
  });

  it('a partial configuration is not a configuration', () => {
    setEnv({ DISCOVERY_PROVIDER_NAME: 'acme-data', DISCOVERY_ENDPOINT: 'https://api.acme-data.example/v1' });
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('DISCOVERY_API_KEY');
  });
});

describe('2. NO CONFIGURATION MESSAGE CONTAINS A SECRET', () => {
  it('not for a bad endpoint, a bad map, an unknown field or a bad ceiling', () => {
    const cases = [
      { ...GOOD_ENV, DISCOVERY_ENDPOINT: 'http://api.acme-data.example/v1' },
      { ...GOOD_ENV, DISCOVERY_FIELD_MAP: 'not json' },
      { ...GOOD_ENV, DISCOVERY_FIELD_MAP: JSON.stringify({ consentGiven: 'x.y', email: 'e' }) },
      { ...GOOD_ENV, DISCOVERY_FIELD_MAP: JSON.stringify({ companyName: 'org.name' }) },
      { ...GOOD_ENV, DISCOVERY_SUPPORTED_FILTERS: 'country,favouriteColour' },
      { ...GOOD_ENV, DISCOVERY_COST_CEILING_MINOR: '-1' },
      { ...GOOD_ENV, DISCOVERY_COST_CEILING_MINOR: 'free' },
    ];
    for (const env of cases) {
      setEnv(env);
      const outcome = readHttpDiscoveryConfig();
      expect(outcome.ok, JSON.stringify(env.DISCOVERY_FIELD_MAP)).toBe(false);
      if (outcome.ok) continue;
      // An error string reaches logs. A refusal that helpfully echoes the key has published it.
      expect(outcome.message).not.toContain(SECRET);
      expect(outcome.message).not.toContain('sk-live');
    }
  });
});

describe('3. the field map cannot widen what the system accepts', () => {
  it('refuses a mapping for a field no external source may assert', () => {
    for (const forbidden of ['consentGiven', 'suppressed', 'unsubscribed', 'lawfulBasis', 'liaId', 'organizationId']) {
      setEnv({ ...GOOD_ENV, DISCOVERY_FIELD_MAP: JSON.stringify({ email: 'e', [forbidden]: 'x' }) });
      const outcome = readHttpDiscoveryConfig();
      expect(outcome.ok, forbidden).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('UNKNOWN_FIELD');
    }
  });

  it('the permitted set excludes every consent and suppression field', () => {
    for (const forbidden of ['consentGiven', 'suppressed', 'unsubscribed', 'hardBounced', 'complained', 'lawfulBasis', 'liaId', 'article14NoticeSentAt']) {
      expect(MAPPABLE_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('refuses a configuration with no email mapping at all', () => {
    setEnv({ ...GOOD_ENV, DISCOVERY_FIELD_MAP: JSON.stringify({ companyName: 'org.name' }) });
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_EMAIL_MAPPING');
  });

  it('refuses a declared filter it cannot actually send', () => {
    // Declaring a filter it would silently drop is worse than declaring none: the service
    // refuses an unsupported filter BEFORE spending money, and that refusal is only correct
    // if this list is honest.
    setEnv({ ...GOOD_ENV, DISCOVERY_SUPPORTED_FILTERS: 'country,seniority' });
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('UNKNOWN_FILTER');
  });

  it('refuses a plaintext endpoint', () => {
    setEnv({ ...GOOD_ENV, DISCOVERY_ENDPOINT: 'http://api.acme-data.example/v1' });
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BAD_ENDPOINT');
  });

  it('a complete configuration loads, with sensible defaults for what was not set', () => {
    setEnv(GOOD_ENV);
    const outcome = readHttpDiscoveryConfig();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.config.authHeader).toBe('Authorization');
    expect(outcome.config.authScheme).toBe('Bearer');
    expect(outcome.config.costCeilingMinor).toBe(500);
    expect([...outcome.config.supportedFilters]).toEqual(['country', 'industry', 'limit']);
  });
});

describe('4. walking a stranger JSON body', () => {
  it('returns undefined for a missing key, a null in the middle, and a wrong type', () => {
    expect(atPath({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(atPath({ a: null }, 'a.b')).toBeUndefined();
    expect(atPath({ a: 'string' }, 'a.b')).toBeUndefined();
    expect(atPath(null, 'a')).toBeUndefined();
    expect(atPath({ a: { b: 7 } }, 'a.b')).toBe(7);
  });

  /**
   * A MUTATION SURVIVOR SHARPENED THIS ONE.
   *
   * `atPath({}, '__proto__.polluted')` returns undefined with the guard AND without it, because
   * `Object.prototype.polluted` does not exist either. The test proved nothing. What the guard
   * actually prevents is a configured path READING THE ENGINE rather than the response: with it
   * removed, `constructor.name` resolves to the string "Object", so a field map pointing there
   * would stamp "Object" into a company name for every record a provider ever returned — a
   * value that came from neither us nor them.
   */
  it('refuses prototype keys as path segments, including ones that would resolve', () => {
    expect(atPath({}, 'constructor.name')).toBeUndefined();
    expect(atPath({}, '__proto__.constructor')).toBeUndefined();
    expect(atPath({}, '__proto__.polluted')).toBeUndefined();
    expect(atPath({}, 'constructor.prototype')).toBeUndefined();
    // And a record mapped through such a path yields nothing rather than engine internals.
    const c = config({ fieldMap: { email: 'contact.email', companyName: 'constructor.name' } });
    const mapped = mapRecord({ person_id: 'p1', contact: { email: 'a@b.example' } }, c);
    expect(mapped!.companyName).toBeUndefined();
  });

  it('coerces numbers and booleans but not objects or arrays', () => {
    const c = config({ fieldMap: { email: 'e', employeeCount: 'n', companyName: 'o' } });
    const mapped = mapRecord({ person_id: 'p1', e: 'a@b.example', n: 42, o: { name: 'nested' } }, c);
    expect(mapped).not.toBeNull();
    expect(mapped!.employeeCount).toBe('42');
    // `[object Object]` in a company name is a bug wearing a value's clothing.
    expect(mapped!.companyName).toBeUndefined();
  });

  it('DROPS a record with no provider id rather than minting one', () => {
    expect(mapRecord({ e: 'a@b.example' }, config({ fieldMap: { email: 'e' } }))).toBeNull();
    expect(mapRecord({ person_id: '   ', e: 'a@b.example' }, config({ fieldMap: { email: 'e' } }))).toBeNull();
  });

  it('drops a record with no email, because the address is the identity key', () => {
    expect(mapRecord({ person_id: 'p1' }, config({ fieldMap: { email: 'e' } }))).toBeNull();
  });

  it('only sends the filters the provider declared it supports', () => {
    const body = requestBodyFor(
      { country: 'GB', industry: 'dental', limit: 50, companySizeMin: 10 },
      config({ supportedFilters: ['country', 'limit'] })
    );
    expect(body).toEqual({ country: 'GB', limit: 50 });
  });
});

describe('5. the network, and what each outcome means (§32)', () => {
  const QUERY = { country: 'GB', limit: 2 };

  it('maps a well-formed response, and reports the cost the provider stated', async () => {
    stubFetch(() =>
      jsonResponse({
        request_id: 'req-9',
        billing: { cents: 250 },
        data: {
          people: [
            { person_id: 'p1', contact: { email: 'a@acme.example' }, org: { name: 'Acme' } },
            { person_id: 'p2', contact: { email: 'b@acme.example' }, org: { name: 'Acme' } },
          ],
        },
      })
    );
    const out = await new HttpDiscoveryProvider(config({ fieldMap: { email: 'contact.email', companyName: 'org.name' } })).discover(QUERY);
    expect(out.records.length).toBe(2);
    expect(out.records[0].providerRecordId).toBe('p1');
    expect(out.records[0].email).toBe('a@acme.example');
    expect(out.costMinor).toBe(250);
    expect(out.costIsUpperBound).toBe(false);
    expect(out.queryId).toBe('req-9');
  });

  it('falls back to the CEILING when the provider does not say what it charged', async () => {
    stubFetch(() => jsonResponse({ data: { people: [] } }));
    const out = await new HttpDiscoveryProvider(config({ costCeilingMinor: 900 })).discover(QUERY);
    expect(out.costMinor).toBe(900);
    // Flagged, so the spend gate errs towards refusing rather than towards overspending.
    expect(out.costIsUpperBound).toBe(true);
  });

  it('a negative or non-numeric cost is treated as unreported, not as free', async () => {
    for (const cents of [-5, 'free', null]) {
      stubFetch(() => jsonResponse({ billing: { cents }, data: { people: [] } }));
      const out = await new HttpDiscoveryProvider(config({ costCeilingMinor: 900 })).discover(QUERY);
      expect(out.costMinor, String(cents)).toBe(900);
      expect(out.costIsUpperBound).toBe(true);
    }
  });

  it('enforces the record limit rather than trusting the provider to', async () => {
    const people = Array.from({ length: 50 }, (_, i) => ({ person_id: `p${i}`, contact: { email: `p${i}@acme.example` } }));
    stubFetch(() => jsonResponse({ data: { people } }));
    const out = await new HttpDiscoveryProvider(config({ fieldMap: { email: 'contact.email' } })).discover({ country: 'GB', limit: 3 });
    // The service bills per record ingested, so a provider that ignores `limit` must not be
    // able to turn a query for three into fifty.
    expect(out.records.length).toBe(3);
  });

  it('a query id falls back to a digest of the request, never to a clock', async () => {
    stubFetch(() => jsonResponse({ data: { people: [] } }));
    const provider = new HttpDiscoveryProvider(config({ queryIdPath: null }));
    const first = await provider.discover(QUERY);
    const second = await provider.discover(QUERY);
    // Two identical queries are the same query. A timestamp would make every one unique and the
    // batch id would stop meaning anything.
    expect(first.queryId).toBe(second.queryId);
    expect(first.queryId).not.toMatch(/\d{10,}/);
  });

  it('classifies each HTTP status by what it means for a retry', async () => {
    const cases: [number, string][] = [
      [401, 'UNAUTHENTICATED'],
      [403, 'PERMISSION_DENIED'],
      [429, 'RATE_LIMITED'],
      [500, 'PROVIDER_UNAVAILABLE'],
      [503, 'PROVIDER_UNAVAILABLE'],
      [400, 'INVALID_REQUEST'],
    ];
    for (const [status, kind] of cases) {
      stubFetch(() => jsonResponse({ error: 'no' }, status));
      await expect(new HttpDiscoveryProvider(config()).discover(QUERY)).rejects.toMatchObject({ kind });
    }
  });

  it('AN UNREADABLE RESPONSE IS AMBIGUOUS, because the provider ran the query and charged', async () => {
    // INVALID_REQUEST would be NOT_APPLIED: no spend recorded, immediate retry permitted. That
    // is how a capped budget is spent twice over and the cap never fires.
    const bad: (() => Response)[] = [
      () => new Response('not json at all', { status: 200 }),
      () => jsonResponse({ data: { people: 'not an array' } }),
    ];
    for (const handler of bad) {
      stubFetch(handler);
      await expect(new HttpDiscoveryProvider(config()).discover(QUERY)).rejects.toMatchObject({ kind: 'UNKNOWN' });
    }
    expect(KIND_DISPOSITION.UNKNOWN.outcome).toBe('AMBIGUOUS');
  });

  /**
   * A MUTATION SURVIVOR SHARPENED THIS ONE TOO.
   *
   * The first version of this test sent a huge body of `x` characters, which is not JSON — so
   * removing the size check changed nothing: the parse threw and produced the same kind. The
   * guard is only observable on a body that is VALID JSON and too large, which is also the only
   * case it exists for. A provider returning four megabytes of well-formed records is not an
   * error; it is a lookup trying to become a bulk download.
   */
  it('refuses an oversized body BEFORE parsing it, even when it is valid JSON', async () => {
    const huge = `{"data":{"people":[]},"pad":"${'x'.repeat(MAX_DISCOVERY_BYTES + 1)}"}`;
    expect(() => JSON.parse(huge)).not.toThrow();
    stubFetch(() => new Response(huge, { status: 200 }));
    const thrown = await new HttpDiscoveryProvider(config())
      .discover(QUERY)
      .then(() => null)
      .catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown.kind).toBe('UNKNOWN');
    expect(thrown.signal).toContain('above the');
  });

  it('a transport throw arrives already classified, never as a bare Error', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const thrown = await new HttpDiscoveryProvider(config())
      .discover(QUERY)
      .then(() => null)
      .catch((e) => e);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect(thrown.provider).toBe('acme-data');
    expect(thrown.operation).toBe('discover');
  });

  it('sends the credential in the configured header, and nowhere else', async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen = init;
      return jsonResponse({ data: { people: [] } });
    }) as unknown as typeof globalThis.fetch;

    await new HttpDiscoveryProvider(config({ authHeader: 'X-Api-Key', authScheme: '' })).discover(QUERY);
    const headers = seen!.headers as Record<string, string>;
    expect(headers['X-Api-Key']).toBe(SECRET);
    expect(headers.Authorization).toBeUndefined();
    // And not in the body, which is the other place a key gets copied into by accident.
    expect(String(seen!.body)).not.toContain(SECRET);
  });
});

describe('6. the source says what the tests say', () => {
  const source = stripComments(readFileSync('server/providers/httpDiscovery.provider.ts', 'utf8'));

  it('the config reader never interpolates a value into a message', () => {
    const fn = source.slice(source.indexOf('export function readHttpDiscoveryConfig'), source.indexOf('export function atPath'));
    // `apiKey` is read and compared; it must never reach a template literal.
    expect(fn).not.toMatch(/\$\{apiKey\}/);
    expect(fn).not.toMatch(/JSON\.stringify\(apiKey\)/);
  });

  it('the endpoint is resolution-checked before an adapter is ever built', () => {
    const fn = source.slice(source.indexOf('export async function buildConfiguredDiscoveryProvider'));
    expect(fn).toContain('checkCrawlTarget');
    expect(fn.indexOf('checkCrawlTarget')).toBeLessThan(fn.indexOf('new HttpDiscoveryProvider'));
  });
});
