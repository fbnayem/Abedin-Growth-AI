/**
 * READ-ONLY. What does the live database actually look like right now?
 *
 *   npx tsx scripts/db-verify.ts
 *
 * Every read runs inside `BEGIN READ ONLY`, and the one write it performs — an INSERT as the
 * application role, to prove the role can actually work — is rolled back.
 *
 * WHY THIS IS A COMMITTED SCRIPT AND NOT A SCRATCH FILE
 * -----------------------------------------------------
 * `scripts/db-apply.ts` ends by verifying its own work, which makes it the wrong thing to
 * trust on its own: it checks a state it has just produced, in the same process, under the
 * same assumptions. This asks the same questions from cold, and it can be run by someone who
 * did not run the apply — after a console change, after a restore, before a release.
 *
 * It asks the catalogue rather than the absence of an error. Each check below exists because a
 * plausible-looking alternative was wrong here at least once:
 *
 *   - `information_schema` is privilege-filtered. Read as the application role it reported
 *     zero tables while `pg_class`, read as the owner, reported fourteen and 718 contacts.
 *     Table discovery therefore uses `pg_class`.
 *   - A GRANT or REVOKE returning without error says nothing about the resulting privilege.
 *     `REVOKE CREATE ON SCHEMA public` succeeded, the ACL was correct afterwards, and
 *     `has_schema_privilege` still answered true.
 *   - `has_schema_privilege` counts privileges reached through role MEMBERSHIP, so when it
 *     disagrees with a correct ACL the answer is upstream of the ACL. That is why memberships
 *     are enumerated recursively and reported as their own check rather than left to be
 *     inferred from a contradiction.
 */
import pg from 'pg';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../server/db/schema';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from '../server/db/tls';
import 'dotenv/config';

const APP_ROLE = process.env.APP_DB_ROLE ?? 'growth-ai-dat-user-747';
const EXPECTED_MIGRATIONS = 6;

/** Cloud SQL creates these itself; they are not part of this application's schema. */
const NOT_OURS = "c.relname NOT LIKE 'google_db_advisor%' AND c.relname NOT LIKE 'hypopg%'";


const say = (s = '') => console.log(s);
const problems: string[] = [];
const flag = (s: string) => problems.push(s);

/**
 * Postgres spells the same type several ways depending on who is asked. `information_schema`
 * says `character varying`, drizzle says `varchar(255)`, and neither is more true.
 */
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

(async () => {
  if (!process.env.MIGRATION_DATABASE_URL) {
    console.error('REFUSING: MIGRATION_DATABASE_URL is unset — there is nothing to verify.');
    process.exit(2);
  }

  say('tls               : ' + describePlan(resolveTlsPlan()));

  const owner = new pg.Client({
    ...verifiedPgOptions(process.env.MIGRATION_DATABASE_URL),
    connectionTimeoutMillis: 20000,
  });
  await owner.connect();
  await owner.query('BEGIN READ ONLY');

  // ------------------------------------------------------------------ 1. migrations
  const journal = await owner.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`
  );
  say('migration journal : ' + (journal.rows[0].present === true ? 'present' : 'ABSENT'));
  if (journal.rows[0].present !== true) {
    flag('no drizzle journal — the migrations have not been applied through the migrator');
  } else {
    const applied = await owner.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
    );
    const n = applied.rows[0].n;
    say(`applied migrations: ${n} of ${EXPECTED_MIGRATIONS}`);
    if (n !== EXPECTED_MIGRATIONS) {
      flag(`${n} migrations applied, expected ${EXPECTED_MIGRATIONS}`);
    }
  }

  // ------------------------------------------------------------------ 2. tables and rows
  const tables = await owner.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' AND ${NOT_OURS}
      ORDER BY c.relname`
  );
  const declaredTables = Object.values(schema).filter((v) => v instanceof PgTable).length;
  say(`\napplication tables: ${tables.rows.length}   (schema.ts declares ${declaredTables})`);
  if (tables.rows.length !== declaredTables) {
    flag(`${tables.rows.length} tables in the database, ${declaredTables} declared in schema.ts`);
  }
  let rowTotal = 0;
  for (const t of tables.rows) {
    const n = (await owner.query(`SELECT count(*)::int AS n FROM "public"."${t.name}"`)).rows[0].n;
    rowTotal += n;
    if (n > 0) say('  ' + t.name.padEnd(24) + String(n).padStart(6) + ' rows');
  }
  say('  (total rows: ' + rowTotal + ')');

  // ------------------------------------------------------------------ 3. schema.ts, column by column
  const cols = await owner.query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`
  );
  const live = new Map<string, Map<string, string>>();
  for (const r of cols.rows) {
    if (!live.has(r.table_name)) live.set(r.table_name, new Map());
    live.get(r.table_name)!.set(r.column_name, norm(r.data_type));
  }
  const mismatches: string[] = [];
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value as never);
    const actual = live.get(cfg.name);
    if (actual === undefined) {
      mismatches.push(`table ${cfg.name} missing`);
      continue;
    }
    for (const c of cfg.columns) {
      const got = actual.get(c.name);
      if (got === undefined) mismatches.push(`${cfg.name}.${c.name} missing`);
      else if (got !== norm(c.getSQLType())) {
        mismatches.push(`${cfg.name}.${c.name}: db=${got} schema.ts=${norm(c.getSQLType())}`);
      }
    }
  }
  say('schema mismatches : ' + mismatches.length);
  for (const m of mismatches.slice(0, 15)) say('   - ' + m);
  if (mismatches.length > 15) say('   ... and ' + (mismatches.length - 15) + ' more');
  if (mismatches.length > 0) flag(`${mismatches.length} columns differ from schema.ts`);

  // ------------------------------------------------------------------ 4. role attributes
  const role = await owner.query(
    'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [APP_ROLE]
  );
  if (role.rows.length === 0) {
    say(`\napp role          : NOT FOUND (${APP_ROLE})`);
    flag('the application role does not exist');
  } else {
    const a = role.rows[0];
    say(
      `\napp role attrs    : superuser=${a.rolsuper} createdb=${a.rolcreatedb} ` +
        `createrole=${a.rolcreaterole} bypassrls=${a.rolbypassrls}   (all four must be false)`
    );
    if (a.rolsuper === true) flag('the application role is a superuser');
    if (a.rolcreatedb === true) flag('the application role can create databases');
    if (a.rolcreaterole === true) flag('the application role can create roles');
    if (a.rolbypassrls === true) flag('the application role bypasses row level security');
  }

  // ------------------------------------------------------------------ 5. memberships
  //
  // The check that was missing when `has_schema_privilege` disagreed with a correct ACL. A
  // membership carries every privilege of the group it names, including ones nobody granted
  // deliberately and ones added to that group later.
  const memberships = await owner.query(
    `WITH RECURSIVE m AS (
       SELECT r.oid, r.rolname, 0 AS depth FROM pg_roles r WHERE r.rolname = $1
       UNION ALL
       SELECT g.oid, g.rolname, m.depth + 1
         FROM m
         JOIN pg_auth_members am ON am.member = m.oid
         JOIN pg_roles g ON g.oid = am.roleid
     )
     SELECT rolname, min(depth) AS depth FROM m WHERE depth > 0 GROUP BY rolname
     ORDER BY min(depth), rolname`,
    [APP_ROLE]
  );
  say('app role inherits : ' + (memberships.rows.length === 0 ? '(nothing — correct)' : ''));
  for (const r of memberships.rows) {
    say('  ' + '  '.repeat(Number(r.depth) - 1) + r.rolname);
  }
  if (memberships.rows.length > 0) {
    flag(
      'the application role is a member of ' +
        memberships.rows.map((r) => r.rolname).join(', ') +
        ' — it holds whatever those roles hold, now and after anyone changes them'
    );
  }

  // ------------------------------------------------------------------ 6. schema privileges
  const nsp = await owner.query(
    `SELECT pg_get_userbyid(nspowner) AS owner, coalesce(nspacl::text, '(default: owner only)') AS acl
       FROM pg_namespace WHERE nspname = 'public'`
  );
  say('\nschema public own : ' + nsp.rows[0].owner);
  say('schema public ACL : ' + nsp.rows[0].acl);

  const create = await owner.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [
    APP_ROLE,
  ]);
  say('app role CREATE   : ' + create.rows[0].c + '   (must be false)');
  if (create.rows[0].c === true) {
    flag('the application role can create objects in schema public');
  }

  // ------------------------------------------------------------------ 7. table privileges
  const priv = await owner.query(
    `SELECT
       count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT')) AS can_select,
       count(*) FILTER (WHERE NOT has_table_privilege($1, c.oid, 'SELECT')) AS cannot_select,
       count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'INSERT')) AS can_insert,
       count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'TRUNCATE')) AS can_truncate
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public' AND ${NOT_OURS}`,
    [APP_ROLE]
  );
  const p = priv.rows[0];
  say(
    `app role privs    : SELECT ${p.can_select}, INSERT ${p.can_insert}, ` +
      `cannot SELECT ${p.cannot_select} (want 0), can TRUNCATE ${p.can_truncate} (want 0)`
  );
  if (Number(p.cannot_select) > 0) {
    flag(`${p.cannot_select} tables the application role cannot read`);
  }
  if (Number(p.can_truncate) > 0) {
    flag(`${p.can_truncate} tables the application role can TRUNCATE`);
  }

  await owner.query('ROLLBACK');
  await owner.end();

  // ------------------------------------------------------------------ 8. can it actually work?
  //
  // Privileges that read correctly and a connection that cannot write are different failures,
  // and only one of them is visible in the catalogue.
  const app = new pg.Client(verifiedPgOptions(process.env.DATABASE_URL as string));
  await app.connect();
  try {
    await app.query('BEGIN');
    await app.query(`INSERT INTO "organizations" ("id","name","slug") VALUES ($1,$2,$3)`, [
      '__verify_probe__',
      'probe',
      '__verify_probe__',
    ]);
    const back = await app.query(`SELECT count(*)::int AS n FROM organizations WHERE id = $1`, [
      '__verify_probe__',
    ]);
    const ok = back.rows[0].n === 1;
    say('app INSERT+SELECT : ' + (ok ? 'ok' : 'FAILED'));
    if (!ok) flag('the application role could not read back its own insert');
  } catch (e) {
    say('app INSERT+SELECT : FAILED — ' + (e as Error).message);
    flag('the application role cannot insert: ' + (e as Error).message);
  } finally {
    await app.query('ROLLBACK');
    await app.end();
  }

  say('');
  if (problems.length === 0) {
    say('ALL CHECKS PASSED.');
    return;
  }
  say(problems.length + ' PROBLEM(S):');
  for (const x of problems) say('  - ' + x);
  process.exitCode = 1;
})().catch((e) => {
  console.error('FAILED: ' + (e as Error).message);
  process.exit(2);
});
