import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrationFilesInOrder } from '../../scripts/lib/migration-tables';
import { statementsOf } from '../../scripts/lib/migration-reverse';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { documents } from '../db/schema';

/**
 * TENANT INTEGRITY AT THE DATABASE LEVEL (S4).
 *
 * Until 2026-09-12 the document store was tenant-safe by construction only: the path names the
 * organisation, `org_id` is derived from the path, and every query carries the path. A query
 * with a defective predicate, a script connecting with the application's credentials, or a
 * future Drizzle statement on `documents` could read or write any tenant's rows, because the
 * database itself enforced nothing. Now it does: a CHECK holds `org_id` equal to the tenant the
 * path names; row-level security, FORCED so that even the owning role is subject to it, shows a
 * connection only the rows of the tenant it has NAMED through `app.org_id` (and the tenantless
 * top-level documents), and refuses a write that would land in any other tenant's rows; and the
 * store names the tenant to the database before every statement, from the path it is about to
 * touch. A connection that names no tenant sees no tenant's rows. That is the fail-closed shape
 * §14 asks for, one layer below the application.
 *
 * Proved on a real engine: PGlite runs every migration, a non-superuser role is created (a
 * superuser bypasses row security, which is why the application must never be one), and the
 * refusals are observed as the errors PostgreSQL raises.
 */

const ROOT = process.cwd();

async function applyAll(db: PGlite): Promise<void> {
  for (const file of migrationFilesInOrder(join(ROOT, 'drizzle'))) {
    for (const statement of statementsOf(readFileSync(join(ROOT, 'drizzle', file), 'utf8'))) await db.exec(statement);
  }
}

describe('1. the database refuses a cross-tenant row, and hides other tenants from a named connection', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    await applyAll(db);
    await db.exec(`CREATE ROLE app_probe NOSUPERUSER NOBYPASSRLS LOGIN`);
    await db.exec(`GRANT USAGE ON SCHEMA public TO app_probe`);
    await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO app_probe`);
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  const asTenant = async (org: string | null, sql: string, params: unknown[] = []) => {
    // One transaction, the way the store does it: name the tenant, then the statement.
    await db.exec('BEGIN');
    try {
      await db.exec('SET LOCAL ROLE app_probe');
      await db.query(`SELECT set_config('app.org_id', $1, true)`, [org ?? '']);
      const result = await db.query(sql, params);
      await db.exec('COMMIT');
      return result;
    } catch (e) {
      await db.exec('ROLLBACK');
      throw e;
    }
  };

  const insert = (org: string | null, path: string, id: string, orgIdColumn: string | null) =>
    asTenant(org, `INSERT INTO documents (path, id, org_id, data) VALUES ($1, $2, $3, '{}'::jsonb)`, [path, id, orgIdColumn]);

  it('the migration enabled and forced row security on documents, with the one policy', async () => {
    const rls = await db.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.documents'::regclass`
    );
    expect(rls.rows[0]).toEqual({ enabled: true, forced: true });
    const policies = await db.query<{ polname: string }>(`SELECT polname FROM pg_policy WHERE polrelid = 'public.documents'::regclass`);
    expect(policies.rows.map((r) => r.polname)).toEqual(['documents_tenant']);
  });

  it('THE INVARIANT — org_id cannot disagree with the path: the CHECK refuses the row', async () => {
    // A tenant path with no org_id passes the policy (`org_id IS NULL`), so this is the
    // constraint speaking, not the policy.
    await expect(insert('org-a', 'organizations/org-a/contacts', 'c1', null)).rejects.toThrow(/documents_org_matches_path/i);
    // A wrong tenant on a tenant path, or a tenant on a tenantless path: refused — by the
    // policy first (PostgreSQL checks row security before table constraints), by the CHECK
    // otherwise. Either way the row does not land.
    await expect(insert('org-a', 'organizations/org-a/contacts', 'c1', 'org-b')).rejects.toThrow(/documents_org_matches_path|row-level security/i);
    await expect(insert(null, 'oauth_connections', 'o1', 'org-a')).rejects.toThrow(/documents_org_matches_path|row-level security/i);
    const nothing = await db.query(`SELECT count(*)::int AS n FROM documents`);
    expect(nothing.rows).toEqual([{ n: 0 }]);
  });

  it('THE INVARIANT — a connection that has named org-a cannot write a row into org-b', async () => {
    await insert('org-a', 'organizations/org-a/contacts', 'c1', 'org-a');
    await expect(insert('org-a', 'organizations/org-b/contacts', 'c9', 'org-b')).rejects.toThrow(/row-level security|policy/i);
    await insert('org-b', 'organizations/org-b/contacts', 'c2', 'org-b');
    await insert(null, 'oauth_connections', 'o1', null);
  });

  it('THE INVARIANT — a named connection sees its own tenant and the tenantless documents, and nothing of any other tenant', async () => {
    const seenByA = await asTenant('org-a', `SELECT path, id FROM documents ORDER BY path, id`);
    expect(seenByA.rows).toEqual([
      { path: 'oauth_connections', id: 'o1' },
      { path: 'organizations/org-a/contacts', id: 'c1' },
    ]);
    const seenByB = await asTenant('org-b', `SELECT path, id FROM documents WHERE path = $1`, ['organizations/org-a/contacts']);
    expect(seenByB.rows).toEqual([]);
  });

  it('THE INVARIANT — a connection that names no tenant sees no tenant at all', async () => {
    const seen = await asTenant(null, `SELECT path, id FROM documents ORDER BY path, id`);
    expect(seen.rows).toEqual([{ path: 'oauth_connections', id: 'o1' }]);
    const named = await asTenant('org-a', `SELECT count(*)::int AS n FROM documents WHERE path LIKE 'organizations/%'`);
    expect(named.rows).toEqual([{ n: 1 }]);
  });

  it("an update or delete aimed at another tenant's row touches nothing, even with the exact path and id", async () => {
    const updated = await asTenant('org-a', `UPDATE documents SET data = '{"x":1}'::jsonb WHERE path = $1 AND id = $2`, ['organizations/org-b/contacts', 'c2']);
    expect(updated.affectedRows ?? 0).toBe(0);
    const deleted = await asTenant('org-a', `DELETE FROM documents WHERE path = $1 AND id = $2`, ['organizations/org-b/contacts', 'c2']);
    expect(deleted.affectedRows ?? 0).toBe(0);
    const still = await asTenant('org-b', `SELECT data FROM documents WHERE path = $1 AND id = $2`, ['organizations/org-b/contacts', 'c2']);
    expect(still.rows).toEqual([{ data: {} }]);
  });

  it('the owning role is subject to the policy too (FORCE), so a script with the owner credentials is not a back door', async () => {
    // PGlite's default role is a superuser, which bypasses row security by definition; the
    // FORCE flag is what makes a non-superuser OWNER subject to it. Asserted on the catalogue
    // above; here the policy is shown to bind a second non-superuser role that owns nothing.
    await db.exec(`CREATE ROLE second_probe NOSUPERUSER NOBYPASSRLS`);
    await db.exec(`GRANT USAGE ON SCHEMA public TO second_probe`);
    await db.exec(`GRANT SELECT ON documents TO second_probe`);
    await db.exec('BEGIN');
    await db.exec('SET LOCAL ROLE second_probe');
    const seen = await db.query(`SELECT count(*)::int AS n FROM documents`);
    await db.exec('ROLLBACK');
    expect(seen.rows).toEqual([{ n: 1 }]);
  });
});

// =============================================================================================
// =============================================================================================
describe('1b. the schema declares what the migration made, and the snapshot records it', () => {
  it('documents: row security on, the one policy, the one CHECK — in schema.ts and in the latest snapshot', () => {
    const config = getTableConfig(documents);
    expect(config.enableRLS).toBe(true);
    expect(config.policies.map((p) => p.name)).toEqual(['documents_tenant']);
    expect(config.checks.map((c) => c.name)).toEqual(['documents_org_matches_path']);
    const journal = JSON.parse(readFileSync(join(ROOT, 'drizzle', 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const last = journal.entries[journal.entries.length - 1];
    const snapshot = JSON.parse(readFileSync(join(ROOT, 'drizzle', 'meta', `${String(last.idx).padStart(4, '0')}_snapshot.json`), 'utf8')) as {
      tables: Record<string, { isRLSEnabled: boolean; policies: Record<string, unknown>; checkConstraints: Record<string, unknown> }>;
    };
    const table = snapshot.tables['public.documents'];
    expect(table.isRLSEnabled).toBe(true);
    expect(Object.keys(table.policies)).toEqual(['documents_tenant']);
    expect(Object.keys(table.checkConstraints)).toEqual(['documents_org_matches_path']);
    // FORCE is not something drizzle records; the migration states it and the ladder holds it.
    expect(readFileSync(join(ROOT, 'drizzle', `${last.tag}.sql`), 'utf8')).toContain('FORCE ROW LEVEL SECURITY');
  });
});

// The fake connection the store is given in part 2. Hoisted with the mock: vi.mock is top-level.
const log: { text: string; values?: unknown[] }[] = [];
const client = {
  query: async (text: string, values?: unknown[]) => {
    log.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    return { rows: [], rowCount: 0 };
  },
  release: () => undefined,
};
const pool = { connect: async () => client, query: client.query };
vi.mock('../db/index', () => ({ createPool: () => pool }));

describe('2. the store names the tenant to the database before every statement, from the path', () => {

  it('a read of a tenant path opens a transaction, names the tenant, reads, commits', async () => {
    const store = await import('../store');
    log.length = 0;
    await store.getDoc(store.doc(store.store, 'organizations/org-a/contacts', 'c1'));
    expect(log.map((l) => l.text)).toEqual([
      'BEGIN',
      "SELECT set_config('app.org_id', $1, true)",
      'SELECT data FROM documents WHERE path = $1 AND id = $2',
      'COMMIT',
    ]);
    expect(log[1].values).toEqual(['org-a']);
  });

  it('a tenantless path names the empty tenant, which matches no organisation', async () => {
    const store = await import('../store');
    log.length = 0;
    await store.getDocs(store.query(store.collection(store.store, 'oauth_connections'), store.where('provider', '==', 'gmail')));
    expect(log[1]).toEqual({ text: "SELECT set_config('app.org_id', $1, true)", values: [''] });
  });

  it('every write names the tenant of the path it writes to, before the statement', async () => {
    const store = await import('../store');
    for (const op of [
      () => store.setDoc(store.doc(store.store, 'organizations/org-b/campaigns', 'k1'), { a: 1 }),
      () => store.deleteDoc(store.doc(store.store, 'organizations/org-b/campaigns', 'k1')),
    ]) {
      log.length = 0;
      await op();
      expect(log[0].text).toBe('BEGIN');
      expect(log[1]).toEqual({ text: "SELECT set_config('app.org_id', $1, true)", values: ['org-b'] });
      expect(log[log.length - 1].text).toBe('COMMIT');
    }
  });

  it('inside a transaction, each operation names its own tenant on the same connection', async () => {
    const store = await import('../store');
    log.length = 0;
    await store.runTransaction(store.store, async (tx) => {
      await tx.get(store.doc(store.store, 'organizations/org-a/contacts', 'c1'));
      await tx.set(store.doc(store.store, 'organizations/org-a/contacts', 'c1'), { x: 1 });
    });
    const settings = log.filter((l) => l.text.startsWith("SELECT set_config('app.org_id'"));
    expect(settings.map((s) => s.values)).toEqual([['org-a'], ['org-a']]);
    expect(log[0].text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(log[log.length - 1].text).toBe('COMMIT');
  });

  it('a failed statement rolls the naming transaction back, and the error is the statement\'s', async () => {
    const store = await import('../store');
    const failing = { ...client, query: async (text: string, values?: unknown[]) => { log.push({ text: text.replace(/\s+/g, ' ').trim(), values }); if (text.startsWith('DELETE')) throw new Error('boom'); return { rows: [], rowCount: 0 }; } };
    pool.connect = async () => failing;
    try {
      log.length = 0;
      await expect(store.deleteDoc(store.doc(store.store, 'organizations/org-a/contacts', 'c1'))).rejects.toThrow('boom');
      expect(log.map((l) => l.text)).toEqual(['BEGIN', "SELECT set_config('app.org_id', $1, true)", 'DELETE FROM documents WHERE path = $1 AND id = $2', 'ROLLBACK']);
    } finally {
      pool.connect = async () => client;
    }
  });
});
