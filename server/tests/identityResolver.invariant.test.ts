import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * INVARIANTS FOR RESOLVING AN INBOUND ADDRESS TO A CONTACT (P1.5 / §29 / §18).
 *
 * This service is on the live inbound path — `inboundPipeline` calls it for every arriving message
 * — and had no test of any kind. Its own header records three defects it was written to fix, and
 * nothing held any of them:
 *
 *   1. The lookup compared `contacts.primary_email` while uniqueness is enforced on `email_key`, so
 *      an inbound `Alice@Example.COM` did not match a stored `alice@example.com`, resolved to no
 *      contact, and the message was dropped by the caller's `if (!identity.contactId) return`.
 *   2. The domain pattern was built from the `From` header with `ilike('%@' + domain)`. `%` and `_`
 *      are LIKE wildcards, so a sender whose address ends `@%` produced `%@%` — matching the first
 *      contact in the tenant and handing the sender that contact's account.
 *   3. The return value was cast `as any` and carried fields `ClientIdentityResolution` does not
 *      declare, so any caller reading the declared ones got `undefined`.
 *
 * A fix with no test is a fix that lasts until the next edit.
 */

let contactRows: any[] = [];
let domainRows: any[] = [];
let conversationRows: any[] = [];
let queriedTables: string[] = [];
let contactQueries = 0;

/** Drizzle's chain: `.where()` may be followed by `.orderBy()` and/or `.limit()`. */
function rows(list: any[]): any {
  const result: any = [...list];
  result.limit = () => [...list];
  result.orderBy = () => rows(list);
  return result;
}

function tableName(table: any): string {
  return String(table?.[Symbol.for('drizzle:Name')] ?? '');
}

vi.mock('../db/index', () => ({
  db: {
    select: () => ({
      from: (table: any) => {
        const name = tableName(table);
        queriedTables.push(name);
        return {
          where: () => {
            if (name.includes('conversation')) return rows(conversationRows);
            // Contacts are queried twice — once by key, then once by domain — and the service only
            // reaches the second when the first found nothing. They are distinguished by CALL
            // ORDER. Keying off `contactRows.length` instead made the EXACT query answer with the
            // domain fixture, so every domain case resolved EXACT_EMAIL and five tests failed.
            contactQueries += 1;
            return rows(contactQueries === 1 ? contactRows : domainRows);
          },
        };
      },
    }),
  },
}));

const { IdentityResolverService } = await import('../services/identityResolver.service');

const resolver = new IdentityResolverService();

beforeEach(() => {
  contactRows = [];
  domainRows = [];
  conversationRows = [];
  queriedTables = [];
  contactQueries = 0;
});

describe('1. the lookup uses the key uniqueness is enforced on', () => {
  it('THE INVARIANT — a differently-cased address matches the stored contact', async () => {
    contactRows = [{ id: 'ct_1', name: 'Alice Smith', accountId: 'acc_1', title: 'Owner' }];

    const identity = await resolver.resolve('Alice@Example.COM', 'org_1');

    expect(identity.contactId).toBe('ct_1');
    expect(identity.resolutionMethod).toBe('EXACT_EMAIL');
    expect(identity.identityConfidence).toBe(1);
    // The normalised key, not the raw header value.
    expect(identity.email).toBe('alice@example.com');
  });

  it('an address that cannot be normalised resolves to nobody, and says why', async () => {
    const identity = await resolver.resolve('not-an-address', 'org_1');

    expect(identity.contactId).toBeUndefined();
    expect(identity.identityConfidence).toBe(0);
    expect(identity.resolutionMethod).toBe('UNRESOLVED_NEW');
    expect(identity.sourceProvenance).toContain('could not be normalised');
  });
});

describe('2. a domain match identifies the company and never the person', () => {
  it('sets no contactId, because someone else at the same company is not this person', async () => {
    domainRows = [{ id: 'ct_other', accountId: 'acc_9' }];

    const identity = await resolver.resolve('new.person@clinic.example', 'org_1');

    expect(identity.contactId).toBeUndefined();
    expect(identity.companyId).toBe('acc_9');
    expect(identity.identityConfidence).toBe(0.5);
    expect(identity.resolutionMethod).toBe('DOMAIN_MATCH');
    expect(identity.sourceProvenance).toContain('person NOT identified');
  });

  it('a public mailbox domain does not identify a company', async () => {
    // Two strangers at gmail.com are not colleagues.
    domainRows = [{ id: 'ct_other', accountId: 'acc_9' }];
    const identity = await resolver.resolve('someone@gmail.com', 'org_1');
    expect(identity.resolutionMethod).toBe('UNRESOLVED_NEW');
    expect(identity.companyId).toBeUndefined();
  });
});

describe('3. §18 — a From header cannot steer the query', () => {
  it('a domain carrying LIKE wildcards is never queried by domain', async () => {
    // `ilike('%@' + domain)` with a domain of `%` produced `%@%`, which matches the first contact
    // in the tenant — handing the sender somebody else's account.
    domainRows = [{ id: 'ct_other', accountId: 'acc_9' }];

    const identity = await resolver.resolve('attacker@ex%ample.com', 'org_1');

    expect(identity.resolutionMethod).toBe('UNRESOLVED_NEW');
    expect(identity.companyId).toBeUndefined();
  });

  it('an underscore is a wildcard too', async () => {
    domainRows = [{ id: 'ct_other', accountId: 'acc_9' }];
    const identity = await resolver.resolve('attacker@ex_ample.com', 'org_1');
    expect(identity.resolutionMethod).toBe('UNRESOLVED_NEW');
  });

  it('and an ordinary hyphenated domain still matches', async () => {
    // The other half: a pattern that refused everything would satisfy both assertions above.
    domainRows = [{ id: 'ct_other', accountId: 'acc_9' }];
    const identity = await resolver.resolve('someone@harley-street.example', 'org_1');
    expect(identity.resolutionMethod).toBe('DOMAIN_MATCH');
  });
});

describe('4. the shape it returns is the shape it declares', () => {
  it('carries no field ClientIdentityResolution does not have', async () => {
    // It returned `isResolved`, `matchedLeadId`, `confidence` and `suggestedAction` behind an
    // `as any`, so every caller reading the declared names got undefined.
    contactRows = [{ id: 'ct_1', name: 'Alice', accountId: null }];
    // Spread into a fresh object rather than cast: `ClientIdentityResolution` does not overlap
    // `Record<string, unknown>` enough for a direct assertion, and this suite is about not
    // asserting things.
    const identity: Record<string, unknown> = {
      ...(await resolver.resolve('alice@clinic.example', 'org_1')),
    };

    for (const absent of ['isResolved', 'matchedLeadId', 'confidence', 'suggestedAction']) {
      expect(identity, absent).not.toHaveProperty(absent);
    }
    expect(identity.identityConfidence).toBeDefined();
    expect(identity.resolutionMethod).toBeDefined();
  });
});

describe('5. every query is scoped to the tenant, and excludes merged records', () => {
  const source = readFileSync('server/services/identityResolver.service.ts', 'utf8');

  it('the exact lookup compares the key uniqueness is enforced on', () => {
    // The behavioural tests above cannot see WHICH column is compared — the double answers with a
    // fixture whatever the predicate says — so the column is asserted here. Comparing
    // `primary_email` while uniqueness is enforced on `email_key` is defect #1 in this service's
    // own header: an inbound `Alice@Example.COM` matched nothing and the message was dropped.
    expect(source).toContain('eq(contacts.emailKey, emailKey)');
    expect(source).not.toMatch(/eq\(contacts\.primaryEmail,/);
  });

  it('all three queries carry the organisation predicate', () => {
    // `organizationId` was a parameter this method accepted and never used, so an inbound email
    // from a person who exists in ANOTHER tenant resolved to that tenant's contact.
    const contactScopes = source.match(/eq\(contacts\.organizationId, organizationId\)/g) ?? [];
    const conversationScopes =
      source.match(/eq\(conversations\.organizationId, organizationId\)/g) ?? [];
    expect(contactScopes.length).toBe(2);
    expect(conversationScopes.length).toBe(1);
  });

  it('and both contact lookups exclude records merged away', () => {
    // A lookup that resolved to a MERGED record would draft against an empty history for a
    // customer who has one.
    const excluded = source.match(/isNull\(contacts\.supersededBy\)/g) ?? [];
    expect(excluded.length).toBe(2);
  });
});
