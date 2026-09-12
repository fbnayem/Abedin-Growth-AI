/**
 * Bring the live database to the schema `server/db/schema.ts` declares, and give the runtime
 * role exactly the privileges it needs.
 *
 *   npx tsx scripts/db-apply.ts              # dry run: says what it would do, changes nothing
 *   npx tsx scripts/db-apply.ts --confirm    # does it
 *
 * WHY THIS EXISTS AS A SCRIPT
 * ---------------------------
 * The steps are destructive, ordered, and each one is only safe because the one before it
 * succeeded. Typed into a console one at a time they are four chances to stop halfway with a
 * database matching no migration at all. Here they are reviewable before they run, and the
 * preconditions are checked by the machine rather than remembered.
 *
 * WHAT IT DOES, AND WHY IN THIS ORDER
 * -----------------------------------
 *   1. Verify the backup. Refuses to continue without one whose row counts match its manifest.
 *   2. Drop the application tables. The live schema matched migration 0001 with no
 *      `__drizzle_migrations` journal, so the tables were built by `drizzle-kit push` or by
 *      hand. The alternative was to write journal rows asserting 0000 and 0001 had been
 *      applied — recording something inferred from a schema diff as though it had been
 *      observed. Running all six migrations produces a journal that describes what happened.
 *   3. Migrate, all six, from nothing.
 *   4. Restore the organizations. Only after the schema is right, so the new nullable columns
 *      exist to receive them.
 *   5. Grant. AFTER the tables exist, because GRANT names tables.
 *   6. Verify — against the catalogue, not against the absence of an error.
 *
 * The 718 contacts are deliberately NOT restored: 19 groups of them collide under
 * `UNIQUE(organization_id, email_key)`, which is what would have made migration 0003 fail.
 * They remain in the backup.
 */
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../server/db/schema';
import { tablesCreatedByMigrations, tablesNoMigrationCreates } from './lib/migration-tables';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from '../server/db/tls';
import 'dotenv/config';

const CONFIRM = process.argv.includes('--confirm');
const BACKUP = (process.argv.find((a) => a.startsWith('--backup=')) ?? '').split('=')[1];
const GRANTS = 'scripts/sql/app-role-privileges.sql';

const say = (s = '') => console.log(s);
const step = (n: number, s: string) => say(`\n[${n}] ${s}`);

function fail(message: string): never {
  console.error('\nREFUSING: ' + message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. The backup is a precondition, not a suggestion.
// ---------------------------------------------------------------------------
step(1, 'Verify the backup');
if (!BACKUP) fail('pass --backup=<dir>. This script will not drop tables without one.');
const manifestPath = join(BACKUP, '_manifest.json');
if (!existsSync(manifestPath)) fail(`no manifest at ${manifestPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  takenAt: string;
  totalRows: number;
  tables: { table: string; rows: number; columns: number }[];
};

for (const t of manifest.tables) {
  const f = join(BACKUP, t.table + '.json');
  if (!existsSync(f)) fail(`backup is incomplete: ${f} is missing`);
  const dump = JSON.parse(readFileSync(f, 'utf8'));
  // The manifest and the dumps are written by the same run, so a mismatch means one of them
  // was edited or truncated afterwards — in which case neither can be trusted.
  if (dump.rows.length !== t.rows) {
    fail(`${t.table}: manifest says ${t.rows} rows, the dump holds ${dump.rows.length}`);
  }
}
say(`    ok — ${manifest.tables.length} tables, ${manifest.totalRows} rows, taken ${manifest.takenAt}`);

/**
 * The drop set comes from the migrations, not from the backup.
 *
 * It used to be `manifest.tables.map((t) => t.table)` — the tables that existed when the backup
 * was taken. The backup describes the past; the migrations describe what is about to be
 * created. They agreed on the day this was written, so the first run worked.
 *
 * The first run created six tables the backup predated. The second run dropped the fourteen the
 * manifest listed, left those six standing, and drizzle failed on
 *
 *     relation "customer_commitments" already exists
 *
 * inside its own transaction — rolling back all six migrations and leaving a database with six
 * orphan tables, an empty journal and no `organizations`. A destructive script meant to be
 * re-runnable that worked exactly once, and said nothing, because its verification only runs
 * after the step that failed.
 */
// S5 — everCreated, not tables: a database one migration behind still holds the table the
// pending migration drops, and a rebuild from nothing must drop that table too.
const APP_TABLES = tablesCreatedByMigrations('drizzle').everCreated;

/**
 * Tables the backup holds that no migration creates. Not fatal — a migration is allowed to have
 * removed a table since the backup — but it is the shape of the bug above and it is worth
 * saying out loud before anything is dropped.
 */
const BACKUP_ONLY = manifest.tables
  .map((t) => t.table)
  .filter((t) => !APP_TABLES.includes(t));
if (BACKUP_ONLY.length > 0) {
  say(`    note: the backup holds ${BACKUP_ONLY.length} table(s) no migration creates: ` +
    BACKUP_ONLY.join(', '));
}

// ---------------------------------------------------------------------------
// Connection strings. Two roles, and the script says which it is using for what.
// ---------------------------------------------------------------------------
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl) fail('MIGRATION_DATABASE_URL is not set.');
if (!appUrl) fail('DATABASE_URL is not set.');
// `fail` returns `never`, but control-flow narrowing is per-function: inside the async body below
// `appUrl` widens back to `string | undefined`. Naming the checked value carries the refusal in.
const APP_URL: string = appUrl;
// Every connection below is verified before a byte of Postgres protocol reaches it. This
// used to be `{ rejectUnauthorized: false }` — a script that drops tables, restores a
// backup and grants privileges, talking to whatever answered on the address.
say(`    ${describePlan(resolveTlsPlan())}`);

const owner = new pg.Client({ ...verifiedPgOptions(ownerUrl), connectionTimeoutMillis: 20000 });

async function main() {
  await owner.connect();
  const who = await owner.query('SELECT current_user, current_database()');
  say(`    owner connection: ${who.rows[0].current_user}@${who.rows[0].current_database}`);

  if (!CONFIRM) {
    say('\n--- DRY RUN. Nothing below has been executed. Re-run with --confirm. ---');
  }

  // -------------------------------------------------------------------------
  // Before dropping anything: is anything standing that this script cannot account for?
  //
  // The drop set now comes from the migrations, so a table a migration creates can no longer go
  // unlisted — that failure is gone by construction. What is left is the other direction: a
  // table no migration creates, sitting in a database that is about to be rebuilt from
  // migrations. This script has no way to know whether dropping it would destroy something or
  // leaving it would break something, and guessing while holding a DROP is the wrong move.
  //
  // It has to be asked here rather than later. Drizzle runs all six migrations in one
  // transaction, so by the time it reports an error the database it describes has already been
  // rolled back out of existence.
  const standing = await owner.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
        AND c.relname NOT LIKE 'google_db_advisor%' AND c.relname NOT LIKE 'hypopg%'
      ORDER BY c.relname`
  );
  const unaccounted = tablesNoMigrationCreates(
    standing.rows.map((r) => r.name as string),
    APP_TABLES
  );
  if (unaccounted.length > 0) {
    fail(
      `${unaccounted.length} table(s) exist that no migration creates: ${unaccounted.join(', ')}.\n` +
        '  Either a migration was deleted after it ran, or something created them outside the\n' +
        '  migrations. Find out which before rebuilding this database from the migrations —\n' +
        '  whichever it is, one of the two records is wrong and this script cannot tell which.'
    );
  }
  say(`    ${standing.rows.length} application table(s) standing, all accounted for`);

  // -------------------------------------------------------------------------
  step(2, `Drop ${APP_TABLES.length} application tables and the drizzle journal`);
  for (const t of APP_TABLES) say(`    DROP TABLE IF EXISTS "public"."${t}" CASCADE`);
  say('    DROP SCHEMA IF EXISTS drizzle CASCADE');
  if (CONFIRM) {
    // One transaction: a partial drop leaves a schema matching no migration at all.
    await owner.query('BEGIN');
    try {
      for (const t of APP_TABLES) await owner.query(`DROP TABLE IF EXISTS "public"."${t}" CASCADE`);
      await owner.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
      await owner.query('COMMIT');
      say('    done');
    } catch (e: any) {
      await owner.query('ROLLBACK');
      fail('drop failed, rolled back: ' + e.message);
    }
  }

  // -------------------------------------------------------------------------
  const migrations = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
  step(3, `Apply ${migrations.length} migrations as the owner`);
  for (const m of migrations) say(`    ${m}`);
  if (CONFIRM) {
    const db = drizzle(owner);
    await migrate(db, { migrationsFolder: 'drizzle' });
    say('    done');
  }

  // -------------------------------------------------------------------------
  const orgs = JSON.parse(readFileSync(join(BACKUP, 'organizations.json'), 'utf8')) as {
    rows: Record<string, unknown>[];
  };
  step(4, `Restore ${orgs.rows.length} organizations`);
  say('    (the 718 contacts are NOT restored — 19 groups collide under');
  say('     UNIQUE(organization_id, email_key), which is what would have failed 0003)');
  if (CONFIRM) {
    for (const row of orgs.rows) {
      // Only the columns the backup actually holds. The columns 0002-0005 added are nullable
      // or defaulted, and inventing values for them here would be fabricating provenance.
      const cols = Object.keys(row);
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
      await owner.query(
        `INSERT INTO "organizations" (${cols.map((c) => `"${c}"`).join(', ')}) ` +
          `VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c])
      );
    }
    const n = await owner.query('SELECT count(*)::int AS n FROM organizations');
    say(`    organizations now: ${n.rows[0].n}`);
  }

  // -------------------------------------------------------------------------
  step(5, `Apply ${GRANTS}`);
  if (!existsSync(GRANTS)) fail(`${GRANTS} is missing.`);
  const grantsSql = readFileSync(GRANTS, 'utf8');
  if (/^\s*\\/m.test(grantsSql)) {
    fail(`${GRANTS} contains psql meta-commands (lines starting with \\), which node cannot run.`);
  }
  if (CONFIRM) {
    await owner.query(grantsSql);
    say('    done');
  }

  // -------------------------------------------------------------------------
  step(6, 'Verify against the catalogue');
  if (!CONFIRM) {
    say('    (skipped in a dry run)');
    await owner.end();
    return;
  }

  // 6a. Live schema vs schema.ts, column by column.
  const live = new Map<string, Map<string, string>>();
  const cols = await owner.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  );
  const norm = (t: string) =>
    t
      .replace(/^character varying/, 'varchar')
      .replace(/^timestamp without time zone$/, 'timestamp')
      .replace(/^timestamp with time zone$/, 'timestamptz')
      .replace(/^integer$/, 'int')
      .replace(/^boolean$/, 'bool')
      .replace(/^double precision$/, 'float8')
      .replace(/\(\d+\)/, '')
      .trim();
  for (const r of cols.rows) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Map());
    live.get(r.table_name)!.set(r.column_name, norm(r.data_type));
  }

  const problems: string[] = [];
  let declaredTables = 0;
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    declaredTables++;
    const cfg = getTableConfig(value as any);
    const actual = live.get(cfg.name);
    if (actual === undefined) {
      problems.push(`table ${cfg.name} is missing from the database`);
      continue;
    }
    for (const c of cfg.columns) {
      const got = actual.get(c.name);
      if (got === undefined) problems.push(`${cfg.name}.${c.name} is missing`);
      else if (got !== norm(c.getSQLType())) {
        problems.push(`${cfg.name}.${c.name}: database has ${got}, schema.ts declares ${norm(c.getSQLType())}`);
      }
    }
  }
  say(`    ${declaredTables} tables declared in schema.ts`);
  say(`    schema mismatches: ${problems.length}`);
  for (const p of problems.slice(0, 20)) say('      - ' + p);

  // 6b. Role attributes.
  const role = await owner.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1`,
    ['growth-ai-dat-user-747']
  );
  const attrs = role.rows[0];
  say(
    `    app role: superuser=${attrs.rolsuper} createdb=${attrs.rolcreatedb} ` +
      `createrole=${attrs.rolcreaterole} bypassrls=${attrs.rolbypassrls}`
  );
  if (attrs.rolsuper || attrs.rolcreatedb || attrs.rolcreaterole || attrs.rolbypassrls) {
    problems.push('the app role still holds an attribute it should not');
  }

  const priv = await owner.query(
    `SELECT
       count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT')) AS can_select,
       count(*) FILTER (WHERE NOT has_table_privilege($1, c.oid, 'SELECT')) AS cannot_select,
       count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'TRUNCATE')) AS can_truncate
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
        AND c.relname NOT LIKE 'google_db_advisor%' AND c.relname NOT LIKE 'hypopg%'`,
    ['growth-ai-dat-user-747']
  );
  const p = priv.rows[0];
  say(`    app role can SELECT ${p.can_select} tables, cannot SELECT ${p.cannot_select}, can TRUNCATE ${p.can_truncate}`);
  if (Number(p.cannot_select) > 0) problems.push(`${p.cannot_select} tables the app role cannot read`);
  if (Number(p.can_truncate) > 0) problems.push(`${p.can_truncate} tables the app role can TRUNCATE`);

  const canCreate = await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [
    'growth-ai-dat-user-747',
  ]);
  say(`    app role can CREATE in schema public: ${canCreate.rows[0].c}`);
  if (canCreate.rows[0].c === true) problems.push('the app role can still create tables');

  await owner.end();

  // 6c. The only test that matters: connect AS the app role and actually write, then undo it.
  // A GRANT that ran without error is not evidence that the application can insert a row.
  const app = new pg.Client({ ...verifiedPgOptions(APP_URL), connectionTimeoutMillis: 20000 });
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(
      `INSERT INTO "organizations" ("id", "name") VALUES ('__db_apply_probe__', 'probe')`
    );
    const readBack = await app.query(
      `SELECT count(*)::int AS n FROM organizations WHERE id = '__db_apply_probe__'`
    );
    say(`    app role INSERT + SELECT round trip: ${readBack.rows[0].n === 1 ? 'ok' : 'FAILED'}`);
    if (readBack.rows[0].n !== 1) problems.push('the app role could not read back its own insert');
  } catch (e: any) {
    say('    app role INSERT: FAILED — ' + e.message);
    problems.push('the app role cannot insert: ' + e.message);
  } finally {
    // Always rolled back. The probe row must not survive this script.
    await app.query('ROLLBACK');
    await app.end();
  }

  say('');
  if (problems.length > 0) {
    console.error(`FAILED with ${problems.length} problem(s):`);
    for (const x of problems) console.error('  - ' + x);
    process.exit(1);
  }
  say('All checks passed. The database matches server/db/schema.ts and the app role is scoped.');
}

main().catch((e) => {
  console.error('\nFAILED: ' + (e?.message ?? e));
  process.exit(1);
});
