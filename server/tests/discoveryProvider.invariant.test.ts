import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
import { memory } from './helpers/memoryDocumentStore';

import {
  AMBIGUOUS_COST_CEILING_MINOR,
  discoverLeads,
  registerDiscoveryProvider,
  type DiscoveryBatchSettings,
} from '../services/discovery.service';
import { _resetLedgerStateForTests } from '../services/tenantSpend.service';
import { ProviderError } from '../lib/providerError';
import { HttpTimeoutError } from '../lib/httpClient';
import type { Attribution } from '../domain/operatorAction';
import type { DiscoveredRecord, DiscoveryProvider, DiscoveryQuery } from '../providers/types';

/**
 * INVARIANTS FOR PAID LEAD DISCOVERY (addendum §14, §18, §32, §A).
 *
 * §A  The flag is off by default and fails closed. Nothing is called and nothing is charged.
 * §14 A purchased record is not a consented one. The provider's opinion of "opted in" is not
 *     accepted, and every record lands unmailable until the notice is recorded.
 * §18 The provider's response is untrusted data. It cannot set a suppression flag, cannot
 *     nominate a lawful basis, and cannot smuggle a spreadsheet formula into a company name.
 * §32 A TIMEOUT IS NOT A FAILURE. The lookup may have run and may have been charged for, so
 *     the spend is recorded at a ceiling and the caller is told to reconcile — never handed an
 *     error it would naturally retry.
 *
 * THE FAKE PROVIDER IS THE POINT
 * ------------------------------
 * No adapter ships with this repository, so every test here drives a double. That is not a
 * weaker test than one against a real API: what is being checked is this system's behaviour at
 * the boundary — what it refuses before the call, what it records when the call is ambiguous,
 * and what it does with whatever comes back. A real vendor would exercise exactly the same
 * code, less reliably.
 */

const ORG = 'org-a';
const NOW = new Date('2026-09-15T12:00:00.000Z');
const OPERATOR: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const QUERY: DiscoveryQuery = { country: 'GB', industry: 'Dental Practices', limit: 10 };

const BATCH: DiscoveryBatchSettings = {
  basis: 'LEGITIMATE_INTEREST',
  liaId: 'lia_2026_q3_uk_b2b',
  addressType: 'ROLE',
  sourceEvidence: 'Q3 UK dental outreach, approved 2026-09-01',
};

const RECORD: DiscoveredRecord = {
  providerRecordId: 'rec_001',
  email: 'info@harleydental.example',
  firstName: 'Jane',
  lastName: 'Okafor',
  title: 'Practice Owner',
  companyName: 'Harley Dental',
  industry: 'Dental Practices',
  country: 'GB',
};

/** A provider double. `behaviour` decides what a call does; `calls` records that it happened. */
class FakeProvider implements DiscoveryProvider {
  readonly providerName = 'fakevendor';
  readonly requiredCapabilities = [] as const;
  supportedFilters: (keyof DiscoveryQuery)[] = ['country', 'industry', 'titles', 'limit'];
  calls: DiscoveryQuery[] = [];
  records: DiscoveredRecord[] = [RECORD];
  costMinor = 25;
  costIsUpperBound = false;
  throws: unknown = null;

  async discover(input: DiscoveryQuery) {
    this.calls.push(input);
    if (this.throws !== null) throw this.throws;
    return {
      records: this.records,
      costMinor: this.costMinor,
      costIsUpperBound: this.costIsUpperBound,
      queryId: 'q_123',
    };
  }
}

let fake: FakeProvider;

const contacts = () =>
  Object.keys(memory.docs).filter((k) => k.startsWith(`organizations/${ORG}/contacts/`));

const storedFor = (id: string) =>
  memory.docs[`organizations/${ORG}/contacts/${id}`] as Record<string, unknown> | undefined;

const ledger = () =>
  Object.entries(memory.docs).filter(([k]) => k.includes('/modelSpend/'));

const spentToday = () => {
  const entry = ledger().find(([k]) => k.includes('day-'));
  return entry ? ((entry[1] as Record<string, unknown>).costMinor as number) : 0;
};

beforeEach(() => {
  memory.reset();
  _resetLedgerStateForTests();
  fake = new FakeProvider();
  registerDiscoveryProvider(fake);
  process.env.REAL_DISCOVERY_ENABLED = 'true';
});

afterEach(() => {
  registerDiscoveryProvider(null);
  delete process.env.REAL_DISCOVERY_ENABLED;
  delete process.env.TENANT_MODEL_SPEND_DAILY_LIMIT_CENTS;
});

const run = (
  query: Partial<DiscoveryQuery> = {},
  batch: Partial<DiscoveryBatchSettings> = {},
  by: Attribution = OPERATOR,
  mode: 'PREVIEW' | 'COMMIT' = 'COMMIT'
) => discoverLeads(ORG, { ...QUERY, ...query }, { ...BATCH, ...batch }, by, { mode, now: NOW });

describe('discovery: the flag is off by default and fails closed', () => {
  it('refuses when the flag is absent, and calls nothing', async () => {
    delete process.env.REAL_DISCOVERY_ENABLED;
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('DISCOVERY_DISABLED');
    expect(fake.calls).toHaveLength(0);
    expect(memory.docs).toEqual({});
  });

  it('every near-miss spelling of true is still off', async () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', '', ' true']) {
      process.env.REAL_DISCOVERY_ENABLED = value;
      const outcome = await run();
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('DISCOVERY_DISABLED');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('the flag being on does not conjure an adapter', async () => {
    registerDiscoveryProvider(null);
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_PROVIDER');
    expect(memory.docs).toEqual({});
  });
});

describe('discovery: everything it refuses BEFORE the network', () => {
  it('an unattributed caller', async () => {
    const outcome = await run({}, {}, NOBODY);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(fake.calls).toHaveLength(0);
  });

  it('a search with no usable country, because the gate would refuse every record it bought', async () => {
    for (const country of ['', 'United Kingdom', 'GBR', '  ', 'g']) {
      const outcome = await run({ country });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('COUNTRY_UNKNOWN');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('legitimate interest with no balancing assessment', async () => {
    const outcome = await run({}, { liaId: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_LIA');
    expect(fake.calls).toHaveLength(0);
  });

  it('a run that does not say what it is for', async () => {
    const outcome = await run({}, { sourceEvidence: '  ' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_SOURCE_EVIDENCE');
    expect(fake.calls).toHaveLength(0);
  });

  it('a filter the provider cannot honour, rather than dropping it and searching wider', async () => {
    // Dropping the filter is the tempting behaviour and the expensive one: a broader search
    // costs more and returns people the operator did not ask for.
    const outcome = await run({ companySizeMin: 10 });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('UNSUPPORTED_FILTER');
      expect(outcome.message).toContain('companySizeMin');
    }
    expect(fake.calls).toHaveLength(0);
  });

  it('a tenant already at its daily spend cap', async () => {
    process.env.TENANT_MODEL_SPEND_DAILY_LIMIT_CENTS = '100';
    memory.docs[`organizations/${ORG}/modelSpend/day-2026-09-15`] = {
      window: 'DAY',
      key: '2026-09-15',
      costMinor: 100,
      currency: 'USD',
      costIsUpperBound: false,
      tokens: 0,
      calls: 1,
      runs: 1,
      updatedAt: NOW.toISOString(),
    };
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('SPEND_CAPPED');
    expect(fake.calls).toHaveLength(0);
    expect(contacts()).toHaveLength(0);
  });
});

describe('discovery: a timeout is not a failure (§32)', () => {
  it('an HTTP timeout records a CEILING against the tenant and refuses', async () => {
    fake.throws = new HttpTimeoutError('https://fakevendor.example/search', 15_000);
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('PROVIDER_AMBIGUOUS');
      expect(outcome.sideEffect).toBe('AMBIGUOUS');
      expect(outcome.message).toContain('Reconcile with the provider');
    }
    // The lookup may have run and may have been charged. Recording nothing would let a retry
    // loop spend past the cap without the cap ever firing.
    expect(spentToday()).toBe(AMBIGUOUS_COST_CEILING_MINOR);
    expect(contacts()).toHaveLength(0);
  });

  it('a dropped connection is ambiguous too: a reset can happen after the request was acted on', async () => {
    fake.throws = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PROVIDER_AMBIGUOUS');
    expect(spentToday()).toBe(AMBIGUOUS_COST_CEILING_MINOR);
  });

  it('a bare Error is UNKNOWN, and UNKNOWN is ambiguous', async () => {
    // An adapter that throws something unclassifiable must not be read as "definitely nothing
    // happened". Guessing from the message text is how that conclusion used to be reached.
    fake.throws = new Error('something went wrong');
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PROVIDER_AMBIGUOUS');
    expect(spentToday()).toBe(AMBIGUOUS_COST_CEILING_MINOR);
  });

  it('a refusal the provider made before acting charges nothing', async () => {
    fake.throws = new ProviderError({
      kind: 'INVALID_REQUEST',
      provider: 'fakevendor',
      operation: 'discover',
      signal: 'status=400',
    });
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('PROVIDER_FAILED');
      expect(outcome.sideEffect).toBe('NOT_APPLIED');
    }
    expect(spentToday()).toBe(0);
  });

  it('a rate limit charges nothing: the provider refused at the edge', async () => {
    fake.throws = new ProviderError({
      kind: 'RATE_LIMITED',
      provider: 'fakevendor',
      operation: 'discover',
      signal: 'status=429',
    });
    const outcome = await run();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PROVIDER_FAILED');
    expect(spentToday()).toBe(0);
  });
});

describe('discovery: the provider is a stranger sending JSON (§18)', () => {
  it('a provider cannot set a suppression flag or claim consent', async () => {
    fake.records = [
      {
        ...RECORD,
        ...({
          consentGiven: true,
          suppressed: false,
          unsubscribed: false,
          lawfulBasis: 'CONSENT',
          organizationId: 'someone-elses-org',
          aiScore: 99,
        } as unknown as DiscoveredRecord),
      },
    ];
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.consentGiven).toBe(false);
    expect(stored.lawfulBasis).toBe('LEGITIMATE_INTEREST');
    expect(stored.suppressed).toBeUndefined();
    expect(stored.unsubscribed).toBeUndefined();
    expect(stored.organizationId).toBe(ORG);
    expect(stored.aiScore).toBeUndefined();
  });

  it('a formula in a provider field is neutralised, exactly as in a CSV', async () => {
    fake.records = [{ ...RECORD, companyName: '=HYPERLINK("https://evil.example","Pricing")' }];
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    expect(String(storedFor(outcome.outcomes[0].contactId)!.companyName).startsWith("'=")).toBe(true);
  });

  it('a record with an unusable address is rejected with a reason, not silently dropped', async () => {
    fake.records = [RECORD, { ...RECORD, providerRecordId: 'rec_002', email: 'not-an-email' }];
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(1);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]).toMatchObject({ providerRecordId: 'rec_002', code: 'UNUSABLE_EMAIL' });
  });

  it('the same address twice in one result set is one contact', async () => {
    fake.records = [RECORD, { ...RECORD, providerRecordId: 'rec_002' }];
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(1);
    expect(outcome.rejected[0].code).toBe('DUPLICATE_IN_RESULT');
  });

  it('a provider that returns more than it was asked for has the excess dropped', async () => {
    fake.records = Array.from({ length: 5 }, (_, i) => ({
      ...RECORD,
      providerRecordId: `rec_${i}`,
      email: `info${i}@acme.example`,
    }));
    const outcome = await run({ limit: 2 });
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(2);
    // The real number is still reported, so a provider ignoring the limit is visible.
    expect(outcome.returned).toBe(5);
  });

  it('a provider record never overwrites a contact that already exists', async () => {
    const first = await run();
    if (!first.ok) throw new Error('refused');
    const id = first.outcomes[0].contactId;
    memory.docs[`organizations/${ORG}/contacts/${id}`] = { ...storedFor(id)!, unsubscribed: true };
    const snapshot = JSON.stringify(storedFor(id));

    const second = await run();
    if (!second.ok) throw new Error('refused');
    expect(second.counts.created).toBe(0);
    expect(second.counts.duplicates).toBe(1);
    expect(JSON.stringify(storedFor(id))).toBe(snapshot);
  });
});

describe('discovery: what a bought record is worth', () => {
  it('it is created and is NOT mailable, because no notice has been sent', async () => {
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(1);
    expect(outcome.counts.mailable).toBe(0);
    expect(outcome.outcomes[0].refusalCode).toBe('LI_NOTICE_NOT_SENT');
  });

  it('the record carries the provider, the query and the provider-issued id', async () => {
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.source).toBe('PROVIDER:fakevendor');
    expect(String(stored.sourceEvidence)).toContain('fakevendor query q_123');
    expect(String(stored.sourceEvidence)).toContain('Dental Practices');
    expect(stored.importBatchId).toBe('disc_fakevendor_q_123');
    expect(outcome.outcomes[0].ref).toBe('fakevendor:rec_001');
  });

  it('the consent fields are empty: buying a list is not evidence anyone agreed', async () => {
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.consentGiven).toBe(false);
    expect(stored.consentEvidence).toBeNull();
    expect(stored.consentSource).toBeNull();
    expect(stored.article14NoticeSentAt).toBeNull();
  });
});

describe('discovery: the money is accounted for', () => {
  it('a successful lookup records what the provider says it charged', async () => {
    fake.costMinor = 137;
    const outcome = await run();
    expect(outcome.ok).toBe(true);
    expect(spentToday()).toBe(137);
    if (outcome.ok) expect(outcome.costMinor).toBe(137);
  });

  it('a ceiling the provider could not pin down is flagged as an upper bound', async () => {
    fake.costIsUpperBound = true;
    const outcome = await run();
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.costIsUpperBound).toBe(true);
    const entry = ledger().find(([k]) => k.includes('day-'))![1] as Record<string, unknown>;
    expect(entry.costIsUpperBound).toBe(true);
  });

  it('a negative or fractional cost cannot credit the ledger', async () => {
    fake.costMinor = -5000;
    await run();
    expect(spentToday()).toBe(0);
  });

  it('a PREVIEW still spends, because the lookup still happened', async () => {
    // The honest behaviour, and the surprising one. A preview of an import is free because it
    // reads local state; a preview of a discovery search has already bought the data.
    const outcome = await run({}, {}, OPERATOR, 'PREVIEW');
    expect(outcome.ok).toBe(true);
    expect(spentToday()).toBe(25);
    expect(contacts()).toHaveLength(0);
  });

  it('a PREVIEW writes no contact, and says what a commit would create', async () => {
    const outcome = await run({}, {}, OPERATOR, 'PREVIEW');
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.wouldCreate).toBe(1);
    expect(outcome.counts.created).toBe(0);
    expect(contacts()).toHaveLength(0);
  });
});
