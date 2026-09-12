import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * INVARIANTS FOR THE DELIVERABILITY SERVICE (S27): the resolver adapter, the cache, and which
 * domain a tenant is judged on.
 *
 * The evaluator's rules are proved in senderIdentity.invariant. What this file holds is the seam
 * between DNS and the evaluator: that absence and failure arrive as different answers, that a
 * verdict is cached for as long as it deserves and no longer, and that the domain judged is the
 * one the tenant actually sends from — its Gmail connection's account, not the settings prose.
 */

let oauthDocs: Record<string, unknown>[] = [];
let storeAvailable = true;
let queryShouldThrow = false;
/** What the fake `node:dns` saw: the servers set on a Resolver, and which path each lookup took. */
let dnsSeen: { servers: string[]; path: ('system' | 'override')[] } = { servers: [], path: [] };

vi.mock('node:dns', () => {
  class Resolver {
    constructor(_opts?: unknown) {}
    setServers(servers: string[]) {
      dnsSeen.servers = servers;
    }
    async resolveTxt(_name: string) {
      dnsSeen.path.push('override');
      return [['v=spf1 -all']];
    }
  }
  return {
    promises: {
      resolveTxt: async (_name: string) => {
        dnsSeen.path.push('system');
        throw Object.assign(new Error('queryTxt ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
      Resolver,
    },
  };
});

vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any) => ref,
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  getDocs: async () => {
    if (queryShouldThrow) throw new Error('datastore unavailable');
    return {
      empty: oauthDocs.length === 0,
      docs: oauthDocs.map((d) => ({ data: () => d })),
      forEach: (fn: (d: { data: () => unknown }) => void) => {
        for (const d of oauthDocs) fn({ data: () => d });
      },
    };
  },
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}` }),
}));

const {
  txtAnswer,
  resolveSenderRecords,
  senderPostureFor,
  tenantSendingDomain,
  tenantDeliverability,
  dkimSelectors,
  dnsResolvers,
  systemTxtResolver,
  _resetPostureCacheForTests,
  _resetResolverForTests,
} = await import('../services/deliverability.service');

/** A resolver that answers from a table; anything not in the table is NXDOMAIN. */
const tableResolver = (table: Record<string, string[][] | Error>) => {
  const calls: string[] = [];
  const resolver = async (name: string) => {
    calls.push(name);
    const v = table[name];
    if (v instanceof Error) throw v;
    if (v === undefined) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
    return v;
  };
  return { resolver, calls };
};
const dnsError = (code: string) => Object.assign(new Error(`queryTxt ${code}`), { code });

const GOOD = {
  'example.co.uk': [['v=spf1 include:_spf.google.com ~all']],
  '_dmarc.example.co.uk': [['v=DMARC1; p=reject; rua=mailto:d@example.co.uk']],
  'google._domainkey.example.co.uk': [['v=DKIM1; k=rsa; ', 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC']],
};

beforeEach(() => {
  oauthDocs = [];
  storeAvailable = true;
  queryShouldThrow = false;
  _resetPostureCacheForTests();
  _resetResolverForTests();
  dnsSeen = { servers: [], path: [] };
  delete process.env.DKIM_SELECTORS;
  delete process.env.DNS_RESOLVERS;
});

// =============================================================================================
describe('1. the resolver adapter: absence is an answer, failure is a failure', () => {
  it('NXDOMAIN and ENODATA are "no records", not errors', async () => {
    const { resolver } = tableResolver({ 'x.example': dnsError('ENODATA') });
    expect(await txtAnswer('missing.example', resolver)).toEqual({ ok: true, records: [] });
    expect(await txtAnswer('x.example', resolver)).toEqual({ ok: true, records: [] });
  });

  it('THE INVARIANT — a timeout or SERVFAIL is a failure that names its cause', async () => {
    const { resolver } = tableResolver({ 'slow.example': dnsError('ETIMEOUT'), 'broken.example': dnsError('ESERVFAIL') });
    const slow = await txtAnswer('slow.example', resolver);
    expect(slow.ok).toBe(false);
    expect(slow.ok === false && slow.error).toContain('ETIMEOUT');
    expect((await txtAnswer('broken.example', resolver)).ok).toBe(false);
  });

  it('TXT chunks are joined into one record', async () => {
    const { resolver } = tableResolver(GOOD);
    const a = await txtAnswer('google._domainkey.example.co.uk', resolver);
    expect(a).toEqual({ ok: true, records: ['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC'] });
  });

  it('asks the three questions at the right names, for every configured selector', async () => {
    const { resolver, calls } = tableResolver(GOOD);
    const records = await resolveSenderRecords('example.co.uk', ['google', 'selector1'], resolver);
    expect(calls.sort()).toEqual(['_dmarc.example.co.uk', 'example.co.uk', 'google._domainkey.example.co.uk', 'selector1._domainkey.example.co.uk']);
    expect(records.dkim.map((d) => d.selector)).toEqual(['google', 'selector1']);
    expect(records.dkim[1].answer).toEqual({ ok: true, records: [] });
  });

  it('THE INVARIANT — with DNS_RESOLVERS set, the lookups go to those resolvers and not the system\'s', async () => {
    // Found live: a host whose configured resolver refuses direct queries turns every lookup
    // UNKNOWN and every send into a refusal, correctly, with no way out. This is the way out.
    const system = await txtAnswer('example.co.uk', systemTxtResolver({}));
    expect(system.ok).toBe(false);
    expect(dnsSeen.path).toEqual(['system']);
    _resetResolverForTests();
    const override = await txtAnswer('example.co.uk', systemTxtResolver({ DNS_RESOLVERS: '8.8.8.8, 1.1.1.1' }));
    expect(dnsSeen.servers).toEqual(['8.8.8.8', '1.1.1.1']);
    expect(dnsSeen.path).toEqual(['system', 'override']);
    expect(override).toEqual({ ok: true, records: ['v=spf1 -all'] });
  });

  it('DNS_RESOLVERS names the resolvers to ask, defaults to the system, and refuses a typo rather than falling back', () => {
    expect(dnsResolvers({})).toBeNull();
    expect(dnsResolvers({ DNS_RESOLVERS: ' ' })).toBeNull();
    expect(dnsResolvers({ DNS_RESOLVERS: '8.8.8.8, 1.1.1.1:53' })).toEqual(['8.8.8.8', '1.1.1.1:53']);
    expect(dnsResolvers({ DNS_RESOLVERS: '2001:4860:4860::8888' })).toEqual(['2001:4860:4860::8888']);
    expect(() => dnsResolvers({ DNS_RESOLVERS: '8.8.8.8, dns.google' })).toThrow(/rejected: dns.google/);
  });

  it('the selector list comes from DKIM_SELECTORS, defaults to google, and ignores junk', () => {
    expect(dkimSelectors({})).toEqual(['google']);
    expect(dkimSelectors({ DKIM_SELECTORS: 'google, selector1 ,bad name' })).toEqual(['google', 'selector1']);
    expect(dkimSelectors({ DKIM_SELECTORS: '   ' })).toEqual(['google']);
  });
});

// =============================================================================================
describe('2. the posture is cached for as long as it deserves', () => {
  it('a READY posture is not re-asked within ten minutes, and is after', async () => {
    const { resolver, calls } = tableResolver(GOOD);
    const t0 = 1_700_000_000_000;
    const first = await senderPostureFor('example.co.uk', t0, resolver);
    expect(first.posture.verdict).toBe('READY');
    expect(first.cached).toBe(false);
    const again = await senderPostureFor('example.co.uk', t0 + 9 * 60_000, resolver);
    expect(again.cached).toBe(true);
    expect(calls.length).toBe(3);
    const later = await senderPostureFor('example.co.uk', t0 + 11 * 60_000, resolver);
    expect(later.cached).toBe(false);
    expect(calls.length).toBe(6);
  });

  it('THE INVARIANT — an UNKNOWN posture is a refusal that is re-asked after one minute, not ten', async () => {
    const { resolver, calls } = tableResolver({ ...GOOD, 'example.co.uk': dnsError('ETIMEOUT') });
    const t0 = 1_700_000_000_000;
    const first = await senderPostureFor('example.co.uk', t0, resolver);
    expect(first.posture.verdict).toBe('UNKNOWN');
    await senderPostureFor('example.co.uk', t0 + 30_000, resolver);
    expect(calls.length).toBe(3);
    await senderPostureFor('example.co.uk', t0 + 61_000, resolver);
    expect(calls.length).toBe(6);
  });

  it('domains are cached independently', async () => {
    const { resolver, calls } = tableResolver(GOOD);
    await senderPostureFor('example.co.uk', 1, resolver);
    await senderPostureFor('other.example', 1, resolver);
    expect(calls.length).toBe(6);
  });
});

// =============================================================================================
describe('3. the domain judged is the one the tenant sends from', () => {
  it("THE INVARIANT — the Gmail connection's account, lowercased", async () => {
    oauthDocs = [{ provider: 'gmail', accountEmail: 'Nayem@Example.co.uk', accessToken: 'x' }];
    expect(await tenantSendingDomain('org_1')).toEqual({ ok: true, domain: 'example.co.uk', accountEmail: 'Nayem@Example.co.uk' });
  });

  it('a tenant with no Gmail connection has no sending domain — reported, not passed', async () => {
    oauthDocs = [{ provider: 'linkedin', accountEmail: 'x@y.example' }];
    const r = await tenantSendingDomain('org_1');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('no sending domain');
  });

  it('a connection without an account email, or with an unusable one, is not a domain', async () => {
    oauthDocs = [{ provider: 'gmail', accessToken: 'x' }];
    expect((await tenantSendingDomain('org_1')).ok).toBe(false);
    oauthDocs = [{ provider: 'gmail', accountEmail: 'nobody' }];
    expect((await tenantSendingDomain('org_1')).ok).toBe(false);
  });

  it('an unreadable datastore is not a domain either', async () => {
    storeAvailable = false;
    expect((await tenantSendingDomain('org_1')).ok).toBe(false);
    storeAvailable = true;
    queryShouldThrow = true;
    const r = await tenantSendingDomain('org_1');
    expect(r.ok === false && r.reason).toContain('could not be read');
  });

  it('an invalid organisation id is refused', async () => {
    expect((await tenantSendingDomain('')).ok).toBe(false);
  });
});

// =============================================================================================
describe('4. what the operator is shown names the two parts this system does not measure', () => {
  it('bounces are handled elsewhere and complaint feedback is a console, and both are said', async () => {
    oauthDocs = [];
    const view = await tenantDeliverability('org_1');
    expect(view.posture).toBeNull();
    expect(view.sendingDomain.ok).toBe(false);
    expect(view.bounces).toContain('S28');
    expect(view.bounces).toContain('hardBounced');
    expect(view.complaintFeedback.available).toBe(false);
    expect(view.complaintFeedback.reason).toContain('Postmaster Tools');
    expect(view.resolvers).toBe('system');
  });

  it('the route is read-only and mounted', () => {
    const route = readFileSync('server/routes/deliverability.routes.ts', 'utf8');
    expect(route).toContain('deliverabilityRouter.get(');
    expect(route).not.toMatch(/deliverabilityRouter\.(post|put|patch|delete)\(/);
    expect(readFileSync('server.ts', 'utf8')).toContain('app.use("/api/deliverability", deliverabilityRouter);');
  });
});
