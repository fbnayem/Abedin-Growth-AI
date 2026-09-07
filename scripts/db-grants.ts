import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from '../server/db/tls';

/**
 * APPLY THE PRIVILEGE MODEL, AND NOTHING ELSE.
 *
 * WHY THIS EXISTS SEPARATELY FROM `db-apply.ts`
 * ---------------------------------------------
 * `scripts/sql/app-role-privileges.sql` is the checked-in answer to "what is the application
 * allowed to do?", and until now the only way to apply it was `db-apply.ts --confirm` — which
 * also DROPS AND RECREATES every table. So the safe, additive half of that script could not be
 * run without the destructive half, and a grant that needs adding after a migration meant
 * either rebuilding the database or typing SQL into a console, which is how a privilege model
 * stops matching the file that documents it.
 *
 * This applies the file and stops. It creates nothing, drops nothing and writes no row.
 *
 * It is not idempotent by accident: `GRANT` is idempotent by definition, so running this twice
 * is the same as running it once. That is what makes it safe to run after every migration, and
 * it should be — `ALTER DEFAULT PRIVILEGES` covers tables created by future migrations, but a
 * grant on a NEW SCHEMA (as `drizzle` was) is not covered by anything and has to be applied.
 *
 * Run as the OWNER (MIGRATION_DATABASE_URL): a GRANT can only be made by somebody who holds
 * the privilege being granted.
 */

const GRANTS = 'scripts/sql/app-role-privileges.sql';

function fail(message: string): never {
  console.error('REFUSING: ' + message);
  process.exit(2);
}

async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    fail(
      'MIGRATION_DATABASE_URL is not set. Grants must be applied by the owning role, not by ' +
        'the application role — a role cannot grant itself a privilege it does not hold.'
    );
  }
  if (!existsSync(GRANTS)) fail(`${GRANTS} is missing.`);

  const sql = readFileSync(GRANTS, 'utf8');
  if (/^\s*\\/m.test(sql)) {
    fail(`${GRANTS} contains psql meta-commands (lines starting with \\), which node cannot run.`);
  }

  // The same verified TLS path everything else uses. A privilege model is not worth applying
  // over a connection that could be anybody.
  console.log(describePlan(resolveTlsPlan()));

  const client = new pg.Client(verifiedPgOptions(url));
  await client.connect();
  const who = await client.query('SELECT current_user AS u, current_database() AS d');
  console.log(`connected as ${who.rows[0].u}@${who.rows[0].d}`);

  await client.query(sql);
  console.log(`applied ${GRANTS}`);

  // A GRANT that returned without error is not evidence that the application can read a row —
  // the same reasoning `scripts/db-verify.ts` is built on. The privileges that matter are read
  // back out of the catalogue rather than assumed from the statement having succeeded.
  const checks = await client.query(
    `SELECT
       has_schema_privilege($1, 'public',  'USAGE')  AS public_usage,
       has_schema_privilege($1, 'public',  'CREATE') AS public_create,
       has_schema_privilege($1, 'drizzle', 'USAGE')  AS drizzle_usage,
       has_table_privilege($1, 'drizzle.__drizzle_migrations', 'SELECT') AS migrations_select,
       has_table_privilege($1, 'drizzle.__drizzle_migrations', 'INSERT') AS migrations_insert`,
    [process.env.APP_DB_ROLE ?? 'growth-ai-dat-user-747']
  );
  const r = checks.rows[0];

  const problems: string[] = [];
  const want = (label: string, actual: boolean, expected: boolean) => {
    console.log(`  ${label.padEnd(28)} ${actual}   (want ${expected})`);
    if (actual !== expected) problems.push(label);
  };

  want('USAGE on public', r.public_usage, true);
  want('CREATE on public', r.public_create, false);
  want('USAGE on drizzle', r.drizzle_usage, true);
  want('SELECT on migrations', r.migrations_select, true);
  // The application must never be able to tell the database it has been migrated. A role that
  // can forge that table can defeat the schema-compatibility check that reads it.
  want('INSERT on migrations', r.migrations_insert, false);

  await client.end();

  if (problems.length > 0) {
    console.error(`\n${problems.length} PROBLEM(S): ${problems.join(', ')}`);
    process.exit(1);
  }
  console.log('\nALL PRIVILEGE CHECKS PASSED.');
}

main().catch((e) => {
  console.error('db-grants failed:', e?.message ?? e);
  process.exit(1);
});
