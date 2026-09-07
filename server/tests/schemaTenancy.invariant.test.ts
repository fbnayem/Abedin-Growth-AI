import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * INVARIANTS (addendum §4, §15, §29 / P1.2).
 *
 * §4  Tenant integrity at the database level: every tenant-owned table carries the tenant, and
 *     it is NOT NULL, so a row cannot exist without one.
 * §15 Duplicate work is prevented by a constraint, not by a check-then-write.
 * §29 Identity is resolved through one normalisation, and uniqueness is enforced on the
 *     normalised value rather than the raw one.
 *
 * These are structural assertions over the Drizzle schema. They exist because the failure they
 * guard against is silent and additive: someone adds a table next month, forgets the tenant
 * column, and nothing complains until a customer sees another customer's data. A test that
 * enumerates every table cannot be forgotten in the way a convention can.
 *
 * WHAT THESE DO NOT PROVE: a constraint constrains nothing until something writes through it.
 * DATABASE_URL is unset and the live datastore is Firestore, so these assert the schema is
 * correct, not that production data is protected by it. Say so plainly rather than counting
 * this as coverage of the running system.
 */

/** Every pgTable exported from the schema module, by export name. */
const tables = Object.entries(schema).filter(
  ([, value]) => value && typeof value === 'object' && getTableConfigSafe(value) !== null
);

function getTableConfigSafe(value: any) {
  try {
    const config = getTableConfig(value);
    return config && config.name ? config : null;
  } catch {
    return null;
  }
}

/**
 * `organizations` IS the tenant, so it does not carry a reference to one.
 *
 * `documents` is exempt for a different reason, and the difference is worth stating rather
 * than hiding in a set literal. It holds the document collections that moved out of Firestore,
 * addressed by path. Most of those paths are tenant-scoped and its `org_id` is DERIVED from
 * the path rather than passed alongside it — so the column cannot disagree with the row it
 * describes, which is a stronger property than the FK this rule checks for.
 *
 * It is nullable because three collections legitimately have no tenant: `oauth_connections`,
 * `system_settings`, and `organizations` itself. It carries no foreign key because the
 * `organizations` collection would reference itself at bootstrap.
 *
 * Waiving the rule without replacing it would be the hole this file exists to close, so the
 * property is proved instead in `documents carries a derived tenant` below, and the derivation
 * itself in `store.invariant.test.ts`.
 */
const TENANT_EXEMPT = new Set(['organizations', 'documents']);

describe('§4 — documents carries a derived tenant, since it is exempt from the FK rule', () => {
  const documents = tables.find(([, tbl]) => getTableConfigSafe(tbl)?.name === 'documents');

  it('the table is actually in the schema', () => {
    // Without this the three assertions below pass vacuously if the export is ever renamed,
    // which would silently restore the exemption with nothing standing in its place.
    expect(documents, 'no `documents` table in schema.ts').toBeDefined();
  });

  it('has an org_id column', () => {
    const config = getTableConfigSafe(documents![1])!;
    const column = config.columns.find((c) => c.name === 'org_id');
    expect(column, 'documents has no org_id column').toBeDefined();
  });

  it('org_id is nullable, because three collections have no tenant', () => {
    // Asserted rather than assumed: making it NOT NULL would look like tightening and would
    // in fact break `oauth_connections`, `system_settings` and `organizations`, which are
    // top-level and tenantless by construction.
    const config = getTableConfigSafe(documents![1])!;
    const column = config.columns.find((c) => c.name === 'org_id')!;
    expect(column.notNull).toBe(false);
  });

  it('org_id is indexed, so a tenant question can be asked of the real database', () => {
    // The point of storing the tenant as a column rather than matching a path prefix is that
    // `WHERE org_id <> $1` is a question SQL can answer. An unindexed column makes that
    // question too slow to ask on a real table, and a check nobody runs is not a check.
    const config = getTableConfigSafe(documents![1])!;
    const indexed = config.indexes.some((i) =>
      i.config.columns.some((c: any) => c.name === 'org_id')
    );
    expect(indexed, 'documents.org_id is not indexed').toBe(true);
  });
});

describe('§4 — every tenant-owned table carries the tenant, NOT NULL', () => {
  it('found the schema', () => {
    // Guards against the whole suite passing vacuously if the export shape changes.
    expect(tables.length).toBeGreaterThanOrEqual(19);
  });

  for (const [exportName, table] of tables) {
    const config = getTableConfigSafe(table)!;
    if (TENANT_EXEMPT.has(config.name)) continue;

    it(`${config.name} has organization_id NOT NULL`, () => {
      const column = config.columns.find((c) => c.name === 'organization_id');
      expect(column, `${exportName} has no organization_id column`).toBeDefined();
      expect(column!.notNull, `${config.name}.organization_id is nullable`).toBe(true);
    });

    it(`${config.name}.organization_id references organizations`, () => {
      const fk = config.foreignKeys.find((f) =>
        f.reference().columns.some((c) => c.name === 'organization_id')
      );
      expect(fk, `${config.name}.organization_id has no foreign key`).toBeDefined();
      expect(fk!.reference().foreignTable[Symbol.for('drizzle:Name')]).toBe('organizations');
    });
  }
});

describe('§15/§29 — the five required composite uniques exist and are tenant-first', () => {
  const uniqueOn = (tableName: string, constraintName: string) => {
    const entry = tables.find(([, t]) => getTableConfigSafe(t)?.name === tableName);
    expect(entry, `no table named ${tableName}`).toBeDefined();
    const config = getTableConfigSafe(entry![1])!;
    const unique = config.uniqueConstraints.find((u) => u.name === constraintName);
    expect(unique, `${tableName} has no unique named ${constraintName}`).toBeDefined();
    return unique!.columns.map((c) => c.name);
  };

  it('1. contact normalised email — per tenant, on the DERIVED key', () => {
    const cols = uniqueOn('contacts', 'contacts_org_email_key_unique');
    expect(cols).toEqual(['organization_id', 'email_key']);
    // Constraining primary_email directly would permit the duplicates it appears to prevent:
    // 'Alice@Example.com ' and 'alice@example.com' are different strings, one person.
    expect(cols).not.toContain('primary_email');
  });

  it('2. conversation provider thread — per tenant', () => {
    expect(uniqueOn('conversations', 'conversations_org_thread_unique')).toEqual([
      'organization_id',
      'provider_thread_id',
    ]);
  });

  it('3. message provider id — per tenant', () => {
    expect(uniqueOn('messages', 'messages_org_provider_msg_unique')).toEqual([
      'organization_id',
      'provider',
      'provider_message_id',
    ]);
  });

  it('4. campaign recipient — one enrolment per contact per campaign, per tenant', () => {
    expect(uniqueOn('campaign_recipients', 'campaign_recipients_org_campaign_contact_unique')).toEqual([
      'organization_id',
      'campaign_id',
      'contact_id',
    ]);
  });

  it('5. oauth provider account — per tenant', () => {
    expect(uniqueOn('oauth_connections', 'oauth_org_provider_account_unique')).toEqual([
      'organization_id',
      'provider',
      'account_email',
    ]);
  });

  it('every composite unique names the tenant FIRST', () => {
    // A unique that is not tenant-scoped lets one tenant's row block another tenant's insert.
    // That is an outage and an existence oracle at the same time: the failure tells the caller
    // a row with that value exists in a tenant they cannot see.
    for (const [, table] of tables) {
      const config = getTableConfigSafe(table)!;
      if (TENANT_EXEMPT.has(config.name)) continue;
      for (const unique of config.uniqueConstraints) {
        expect(
          unique.columns[0].name,
          `${config.name}.${unique.name} does not start with organization_id`
        ).toBe('organization_id');
      }
    }
  });
});

describe('§4 — uniques that were global are now per tenant', () => {
  const columnIsUnique = (tableName: string, columnName: string) => {
    const entry = tables.find(([, t]) => getTableConfigSafe(t)?.name === tableName);
    const config = getTableConfigSafe(entry![1])!;
    return config.columns.find((c) => c.name === columnName)?.isUnique === true;
  };

  it('users.email is NOT globally unique', () => {
    // A global unique on email stops one person holding an account in two organisations, and
    // turns "is this address taken?" into a probe for users in someone else's tenant.
    expect(columnIsUnique('users', 'email')).toBe(false);
    const entry = tables.find(([, t]) => getTableConfigSafe(t)?.name === 'users')!;
    const config = getTableConfigSafe(entry[1])!;
    expect(config.uniqueConstraints.some((u) => u.name === 'users_org_email_unique')).toBe(true);
  });

  it('outbox idempotency key is NOT globally unique', () => {
    // Globally unique means one tenant's key can suppress another tenant's send — a silent
    // non-delivery that looks like successful deduplication.
    expect(columnIsUnique('outbox_messages', 'idempotency_key')).toBe(false);
    const entry = tables.find(([, t]) => getTableConfigSafe(t)?.name === 'outbox_messages')!;
    const config = getTableConfigSafe(entry[1])!;
    expect(config.uniqueConstraints.some((u) => u.name === 'outbox_org_idempotency_unique')).toBe(true);
  });
});

describe('§B — the migration is safe against a database that already has rows', () => {
  const migrationDir = 'drizzle';
  const files = readdirSync(migrationDir).filter((f) => f.endsWith('.sql'));

  it('found migrations', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no migration adds a NOT NULL column to an existing table without a default', () => {
    // PostgreSQL rejects `ALTER TABLE t ADD COLUMN c type NOT NULL` outright when t has rows.
    // drizzle-kit generates exactly that, and it passes against an empty database — so the
    // failure only appears the first time the migration meets real data.
    //
    // CREATE TABLE bodies are exempt: NOT NULL on a brand-new table has nothing to violate.
    const offenders: string[] = [];

    for (const file of files) {
      const sql = readFileSync(`${migrationDir}/${file}`, 'utf8');
      // Strip CREATE TABLE (...) bodies before looking for ALTER ... ADD COLUMN.
      const withoutCreates = sql.replace(/CREATE TABLE[\s\S]*?\n\);/g, '');
      for (const line of withoutCreates.split('\n')) {
        // Skip SQL line comments. The rewritten 0003 quotes the unsafe form in its own header
        // to explain why it was replaced, and a check that flags the explanation as the defect
        // teaches people to delete the explanation.
        if (line.trimStart().startsWith('--')) continue;
        if (/ALTER TABLE .* ADD COLUMN .* NOT NULL/i.test(line) && !/DEFAULT/i.test(line)) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the tenancy migration refuses to assign a tenant it cannot derive', () => {
    const sql = readFileSync(`${migrationDir}/0003_secret_selene.sql`, 'utf8');
    // The guard that stops rows with no derivable parent being swept into an arbitrary
    // organisation. Assigning a customer record to the wrong tenant is not a lesser failure
    // than aborting a migration.
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/no derivable tenant/);
  });
});
