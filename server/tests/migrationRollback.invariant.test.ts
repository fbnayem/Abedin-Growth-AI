import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrationFilesInOrder } from '../../scripts/lib/migration-tables';
import {
  downInvertsUp,
  downHeaderOf,
  effectsOf,
  hasDown,
  readDown,
  statementsOf,
} from '../../scripts/lib/migration-reverse';

/**
 * EXPAND / CONTRACT, DEMONSTRATED RATHER THAN CLAIMED (S5).
 *
 * The row said: zero rollback migrations, no test exercises a backfill, expand/contract is a
 * claim. This file runs every migration UP on a real PostgreSQL engine in this process — PGlite,
 * no server, no credential, no live table — photographing the catalogue after each rung, then
 * runs every migration DOWN and checks that each rung's photograph reappears. A reverse that
 * merely exists proves nothing; one that lands the schema exactly where the previous migration
 * left it is a rollback.
 *
 * Between rungs six and seven it puts rows in and watches the one data migration (0007, the
 * bitemporal backfill) fill them and its reverse empty them again — the MIGRATE step of
 * expand/contract that no migration had exercised.
 *
 * Structural check first, engine second: scripts/lib/migration-reverse.ts reduces every
 * statement to its catalogue effect and refuses a reverse that does not invert its up. The
 * rollback script uses the same check before it runs anything against the real database.
 */

const DIR = 'drizzle';
const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
  entries: { idx: number; tag: string; when: number }[];
};
const TAGS = [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
const FILES = migrationFilesInOrder(DIR);
const up = (i: number) => readFileSync(join(DIR, FILES[i]), 'utf8');

// =============================================================================================
describe('1. every migration has a reverse that inverts it, structurally', () => {
  it('there is a down for every journal entry, and no orphan downs', () => {
    for (const tag of TAGS) expect(hasDown(tag, DIR), tag).toBe(true);
    const onDisk = readdirSync(join(DIR, 'down')).filter((f) => f.endsWith('.down.sql'));
    expect(onDisk.sort()).toEqual(TAGS.map((t) => `${t}.down.sql`).sort());
  });

  for (const [i, tag] of TAGS.entries()) {
    it(`${tag}: the down declares what it reverses and inverts every catalogue effect`, () => {
      const down = readDown(tag, DIR);
      const header = downHeaderOf(down);
      expect(header.reverses).toBe(tag);
      const verdict = downInvertsUp(up(i), down);
      expect(verdict.missing, `${tag}: effects of the up the down does not invert`).toEqual([]);
      expect(verdict.extra, `${tag}: effects in the down that invert nothing`).toEqual([]);
      expect(verdict.ok).toBe(true);
    });
  }

  it('every statement in every up and every down is classified — nothing is skipped', () => {
    for (const [i, tag] of TAGS.entries()) {
      expect(() => effectsOf(up(i)), `up ${tag}`).not.toThrow();
      expect(() => effectsOf(readDown(tag, DIR)), `down ${tag}`).not.toThrow();
    }
    expect(() => effectsOf('TRUNCATE "contacts";')).toThrow(/unclassified/);
  });

  it('the check can fail: a down missing a statement, and a down with a stray one', () => {
    const upSql = 'CREATE TABLE "t" ("id" text);--> statement-breakpoint\nALTER TABLE "t" ADD COLUMN "x" text;';
    const BP = '--> statement-breakpoint\n';
    expect(downInvertsUp(upSql, 'ALTER TABLE "t" DROP COLUMN "x";').missing).toEqual(['table:t:-1']);
    expect(downInvertsUp(upSql, `ALTER TABLE "t" DROP COLUMN "x";${BP}DROP TABLE "t";${BP}DROP INDEX "i";`).extra).toEqual(['index:i:-1']);
    expect(downInvertsUp(upSql, `ALTER TABLE "t" DROP COLUMN "x";${BP}DROP TABLE "t";`).ok).toBe(true);
  });

  it('a table drop absorbs its constraints and indexes, in both directions', () => {
    // Up drops the table whole; the down recreates it with its FK and index. Not "extra".
    const dropUp = 'DROP TABLE "t" CASCADE;';
    const BP = '--> statement-breakpoint\n';
    const recreate =
      `CREATE TABLE "t" ("id" text);${BP}ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("id") REFERENCES "u"("id");${BP}CREATE INDEX "t_idx" ON "t" USING btree ("id");`;
    expect(downInvertsUp(dropUp, recreate).ok).toBe(true);
    // Up creates the table and its FK; a bare drop is a complete reverse.
    const createUp = 'CREATE TABLE "t" ("id" text);--> statement-breakpoint\nALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("id") REFERENCES "u"("id");';
    expect(downInvertsUp(createUp, 'DROP TABLE "t";').ok).toBe(true);
    // But an index on a table nobody drops is still owed.
    expect(downInvertsUp('CREATE INDEX "i" ON "keep" USING btree ("a");', '').missing).toEqual(['index:i:-1']);
  });
});

// =============================================================================================
/** The catalogue as a comparable value: tables, columns, constraints, indexes. Order-free. */
async function catalogue(db: PGlite): Promise<string> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const columns = await db.query<Record<string, unknown>>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`
  );
  const constraints = await db.query<Record<string, unknown>>(
    `SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`
  );
  const indexes = await db.query<Record<string, unknown>>(
    `SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2`
  );
  // S4 — policies and the row-security flags are part of the shape a rollback must restore.
  const policies = await db.query<Record<string, unknown>>(
    `SELECT polrelid::regclass::text AS table_name, polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr,
            pg_get_expr(polwithcheck, polrelid) AS check_expr
       FROM pg_policy WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY 1, 2`
  );
  const rowSecurity = await db.query<Record<string, unknown>>(
    `SELECT relname AS table_name, relrowsecurity AS enabled, relforcerowsecurity AS forced
       FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace ORDER BY 1`
  );
  return JSON.stringify({
    tables: tables.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    policies: policies.rows,
    rowSecurity: rowSecurity.rows,
  });
}

async function apply(db: PGlite, sql: string): Promise<void> {
  for (const statement of statementsOf(sql)) await db.exec(statement);
}

describe('2. up the ladder and down again, on a real engine', () => {
  let db: PGlite;
  const rung: string[] = [];
  const tableCount = (c: string) => (JSON.parse(c) as { tables: unknown[] }).tables.length;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('the empty engine has an empty public schema', async () => {
    rung[-1 as unknown as number] = await catalogue(db);
    expect(tableCount(rung[-1 as unknown as number])).toBe(0);
  });

  it('every migration applies in order, and each rung adds or removes what it says', async () => {
    for (let i = 0; i < TAGS.length; i++) {
      if (TAGS[i] === '0007_backfill_valid_from') await seedBitemporalRows(db);
      await apply(db, up(i));
      rung[i] = await catalogue(db);
      if (TAGS[i] === '0007_backfill_valid_from') await expectBackfilled(db);
    }
    expect(tableCount(rung[TAGS.length - 1])).toBeGreaterThan(15);
    // 0008 is the contract step: the table S22 retired is gone from that rung up.
    const drop = TAGS.indexOf('0008_drop_ai_run_logs');
    expect(rung[drop]).not.toContain('"ai_run_logs"');
    expect(rung[drop - 1]).toContain('"ai_run_logs"');
    // 0009 is row security (S4): the CHECK, the policy and the flags are there from that rung up
    // and nowhere below it — the catalogue reads pg_policy and the relrowsecurity flags too.
    const rls = TAGS.indexOf('0009_tenant_row_security');
    expect(rung[rls]).toContain('documents_org_matches_path');
    expect(rung[rls]).toContain('"documents_tenant"');
    expect(rung[rls]).toContain('{"table_name":"documents","enabled":true,"forced":true}');
    expect(rung[rls - 1]).not.toContain('documents_tenant');
    expect(rung[rls - 1]).toContain('{"table_name":"documents","enabled":false,"forced":false}');
  }, 120_000);

  it("THE INVARIANT — every down lands the catalogue exactly where the previous rung's up left it", async () => {
    for (let i = TAGS.length - 1; i >= 0; i--) {
      await apply(db, readDown(TAGS[i], DIR));
      if (TAGS[i] === '0007_backfill_valid_from') await expectUnfilled(db);
      const now = await catalogue(db);
      const before = rung[i - 1 as number] ?? rung[-1 as unknown as number];
      expect(now, `after rolling back ${TAGS[i]}, the catalogue differs from rung ${i - 1}`).toBe(before);
    }
    expect(tableCount(await catalogue(db))).toBe(0);
  }, 120_000);

  it('and up again: the ladder is climbable twice, so a rollback is not a dead end', async () => {
    for (let i = 0; i < TAGS.length; i++) await apply(db, up(i));
    expect(await catalogue(db)).toBe(rung[TAGS.length - 1]);
  }, 120_000);
});

// =============================================================================================
describe("3. drizzle's own migrator arrives at the same top rung", () => {
  it('applying the folder through drizzle-orm matches applying the files statement by statement', async () => {
    const [{ drizzle }, { migrate }] = await Promise.all([
      import('drizzle-orm/pglite'),
      import('drizzle-orm/pglite/migrator'),
    ]);
    const viaDrizzle = new PGlite();
    await viaDrizzle.waitReady;
    await migrate(drizzle(viaDrizzle), { migrationsFolder: DIR });
    const byHand = new PGlite();
    await byHand.waitReady;
    for (let i = 0; i < TAGS.length; i++) await apply(byHand, up(i));
    expect(await catalogue(viaDrizzle)).toBe(await catalogue(byHand));
    // And the migrator recorded every entry, by the journal's timestamps.
    const rows = await viaDrizzle.query<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
    expect(rows.rows[0].n).toBe(TAGS.length);
    await viaDrizzle.close();
    await byHand.close();
  }, 120_000);
});

// =============================================================================================
describe('4. the premise the 0007 reverse rests on holds', () => {
  it('no application code writes valid_from on the relational tables', () => {
    // The reverse nulls rows where valid_from equals what the up copied. That is exact only while
    // nothing else sets valid_from on these tables. Every mention outside the schema is listed
    // here; a new one must be examined against the reverse before it is added.
    const KNOWN = new Set([
      'server/domain/contextBundle.ts', // reads a quote's validFrom into a bundle
      'server/domain/facts.ts', // document-store facts, not the relational tables
      'server/domain/ledgerAdapters.ts', // reads row.validFrom
      'server/lib/factStore.ts', // document-store facts
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === 'tests' ? [] : walk(join(dir, e.name))) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
      );
    const mentions = walk('server')
      .map((p) => p.replace(/\\/g, '/'))
      .filter((p) => p !== 'server/db/schema.ts')
      .filter((p) => /\bvalidFrom\b|\bvalid_from\b/.test(readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1 ')));
    expect(mentions.filter((p) => !KNOWN.has(p))).toEqual([]);
    // Of the known ones, none is a drizzle write.
    for (const p of mentions) {
      const code = readFileSync(p, 'utf8');
      expect(code, p).not.toMatch(/\.(insert|update)\([\s\S]{0,300}validFrom/);
    }
  });
});

// =============================================================================================
describe('5. the rollback decision refuses before anything runs', () => {
  const BP = '--> statement-breakpoint\n';
  const upSql = `CREATE TABLE "t" ("id" text);${BP}ALTER TABLE "t" ADD COLUMN "x" text;`;
  const header = (data: 'SCHEMA_ONLY' | 'DROPS_DATA', reverses = 'm1', affects = 't') =>
    `-- Reverses ${reverses}.\n-- data: ${data}\n${data === 'DROPS_DATA' ? `-- affects: ${affects}\n` : ''}\n`;
  const goodDown = header('DROPS_DATA') + `ALTER TABLE "t" DROP COLUMN "x";${BP}DROP TABLE "t";`;

  it('refuses a migration with no reverse', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    const plan = planRollbackStep({ tag: 'm1', up: upSql, down: null, allowDataLoss: true });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('no down migration');
  });

  it('refuses a reverse that says it reverses something else', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    const plan = planRollbackStep({ tag: 'm1', up: upSql, down: header('DROPS_DATA', 'm0') + 'DROP TABLE "t";', allowDataLoss: true });
    expect(plan.ok === false && plan.reason).toContain('reverses m0, not m1');
  });

  it('THE INVARIANT — refuses a reverse that does not invert its up, and says what is missing', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    const plan = planRollbackStep({ tag: 'm1', up: upSql, down: header('DROPS_DATA') + 'ALTER TABLE "t" DROP COLUMN "x";', allowDataLoss: true });
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.reason).toContain('does not invert its up');
    expect(plan.ok === false && plan.reason).toContain('table:t:-1');
  });

  it('refuses a data-dropping reverse without permission, and allows it with', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    const refused = planRollbackStep({ tag: 'm1', up: upSql, down: goodDown, allowDataLoss: false });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain('--allow-data-loss');
    const allowed = planRollbackStep({ tag: 'm1', up: upSql, down: goodDown, allowDataLoss: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.ok === true && allowed.statements).toEqual(['ALTER TABLE "t" DROP COLUMN "x";', 'DROP TABLE "t";']);
  });

  it('a schema-only reverse needs no permission', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    const plan = planRollbackStep({ tag: 'm1', up: upSql, down: header('SCHEMA_ONLY') + `ALTER TABLE "t" DROP COLUMN "x";${BP}DROP TABLE "t";`, allowDataLoss: false });
    expect(plan.ok).toBe(true);
  });

  it('the real reverses plan cleanly, and every data-dropping one is refused without the flag', async () => {
    const { planRollbackStep } = await import('../../scripts/lib/rollback-plan');
    for (const [i, tag] of TAGS.entries()) {
      const down = readDown(tag, DIR);
      const withFlag = planRollbackStep({ tag, up: up(i), down, allowDataLoss: true });
      expect(withFlag.ok, tag).toBe(true);
      const withoutFlag = planRollbackStep({ tag, up: up(i), down, allowDataLoss: false });
      expect(withoutFlag.ok, tag).toBe(downHeaderOf(down).data === 'SCHEMA_ONLY');
    }
  });

  it('the script executes the plan, as the owner, one migration per transaction', () => {
    const script = readFileSync('scripts/db-rollback.ts', 'utf8');
    expect(script).toContain('process.env.MIGRATION_DATABASE_URL');
    expect(script).toMatch(/const plan = planRollbackStep\(\{ tag: entry\.tag, up, down, allowDataLoss: ALLOW_DATA_LOSS \}\);\s*if \(plan\.ok === false\) fail\(plan\.reason\);/);
    expect(script).toContain('const statements = plan.statements;');
    expect(script).toMatch(/BEGIN[\s\S]*DELETE FROM drizzle\.__drizzle_migrations WHERE created_at = \$1[\s\S]*COMMIT/);
    expect(script).toContain("await client.query('ROLLBACK')");
    expect(script).toContain("process.argv.includes('--confirm')");
    expect(script).toContain('if (!CONFIRM) continue;');
  });
});

// =============================================================================================
describe('6. a table a later migration drops is accounted for, not foreign', () => {
  it('everCreated holds ai_run_logs; the standing set does not', async () => {
    const { tablesCreatedByMigrations, tablesNoMigrationCreates } = await import('../../scripts/lib/migration-tables');
    const derived = tablesCreatedByMigrations(DIR);
    expect(derived.everCreated).toContain('ai_run_logs');
    expect(derived.tables).not.toContain('ai_run_logs');
    // A database one migration behind still holds the table; checked against everCreated it is
    // accounted for, checked against the standing set it would read as foreign and refuse the
    // very migration that removes it.
    expect(tablesNoMigrationCreates(['ai_run_logs', 'contacts'], derived.everCreated)).toEqual([]);
    expect(tablesNoMigrationCreates(['ai_run_logs', 'contacts'], derived.tables)).toEqual(['ai_run_logs']);
  });

  it('both scripts check the standing database against everCreated', () => {
    expect(readFileSync('scripts/migrate.ts', 'utf8')).toContain("tablesCreatedByMigrations('drizzle').everCreated");
    expect(readFileSync('scripts/db-apply.ts', 'utf8')).toContain("const APP_TABLES = tablesCreatedByMigrations('drizzle').everCreated;");
  });
});

// ---------------------------------------------------------------------------------------------
// The rows the backfill is exercised on. Inserted after 0006 (every column they need exists),
// before 0007 runs.
// ---------------------------------------------------------------------------------------------
async function seedBitemporalRows(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO "organizations" ("id", "name", "slug", "created_at") VALUES
      ('org_a', 'A', 'a', '2026-01-01T00:00:00Z'),
      ('org_b', 'B', 'b', '2026-02-01T00:00:00Z');
    UPDATE "organizations" SET "valid_from" = '2025-12-25T00:00:00Z' WHERE "id" = 'org_b';
    INSERT INTO "contacts" ("id", "organization_id", "primary_email", "email_key", "created_at")
      VALUES ('c1', 'org_a', 'x@example.com', 'x@example.com', '2026-03-01T00:00:00Z');
  `);
}

async function expectBackfilled(db: PGlite): Promise<void> {
  const orgs = await db.query<{ id: string; valid_from: string | null; created_at: string }>(
    `SELECT id, valid_from::text, created_at::text FROM organizations ORDER BY id`
  );
  const a = orgs.rows.find((r) => r.id === 'org_a')!;
  const b = orgs.rows.find((r) => r.id === 'org_b')!;
  expect(a.valid_from, 'a NULL valid_from is filled from created_at').toBe(a.created_at);
  expect(b.valid_from, 'a row that already had a value keeps it').toContain('2025-12-25');
  const c = await db.query<{ valid_from: string | null; created_at: string }>(`SELECT valid_from::text, created_at::text FROM contacts`);
  expect(c.rows[0].valid_from).toBe(c.rows[0].created_at);
}

async function expectUnfilled(db: PGlite): Promise<void> {
  const orgs = await db.query<{ id: string; valid_from: string | null }>(`SELECT id, valid_from::text FROM organizations ORDER BY id`);
  expect(orgs.rows.find((r) => r.id === 'org_a')!.valid_from, 'the reverse nulls what the up filled').toBeNull();
  expect(orgs.rows.find((r) => r.id === 'org_b')!.valid_from, 'and leaves a value it did not write').toContain('2025-12-25');
  const c = await db.query<{ valid_from: string | null }>(`SELECT valid_from::text FROM contacts`);
  expect(c.rows[0].valid_from).toBeNull();
}
