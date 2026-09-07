/**
 * Apply pending migrations. The deploy step S48 says does not exist.
 *
 *   npm run migrate
 *
 * WHY IT IS NOT IN `start`
 * ------------------------
 * S48 records "no migrate step in the start path" as the defect, and the obvious reading is to
 * put one there. That would be wrong for this deployment. `start` runs on every replica, so
 * migrating from it means N replicas racing to apply the same DDL on a rolling deploy. Drizzle
 * wraps its run in a transaction, so the losers do not corrupt anything — they fail, and a
 * replica that fails to boot during a deploy is an outage caused by the safety measure.
 *
 * The migrate step belongs in the pipeline, once, before the new replicas start. This is that
 * step. What `start` needs instead is a REFUSAL to serve when the schema is behind, which is a
 * different control and is not this file.
 *
 * WHY NOT `drizzle-kit migrate`
 * -----------------------------
 * Because it would connect on its own terms. `drizzle.config.ts` can only hand a tool an `ssl`
 * option, and in pinned mode there is nothing OpenSSL can verify against, so drizzle-kit cannot
 * open a verified connection to this instance at all (see `server/db/tls.ts`). Drizzle's
 * migrator, driven from here over a socket this repository has already verified, applies the
 * same journal in the same order with the same ledger.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * It does not drop, restore or grant. `scripts/db-apply.ts` does those, deliberately and with a
 * mandatory backup; this only moves the schema forward. Running it against a database with no
 * journal will apply every migration from the beginning, which is correct for a fresh database
 * and is why it refuses when tables exist that no migration created — the same precondition
 * db-apply uses, for the same reason.
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from '../server/db/tls';
import { tablesCreatedByMigrations, tablesNoMigrationCreates } from './lib/migration-tables';
import 'dotenv/config';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error(
    'REFUSING: MIGRATION_DATABASE_URL is not set. Migrations run as the OWNER role, not as the ' +
      'application role — an application that can DROP TABLE means anything reaching it can too.'
  );
  process.exit(2);
}

(async () => {
  console.log(describePlan(resolveTlsPlan()));

  const client = new pg.Client({ ...verifiedPgOptions(url), connectionTimeoutMillis: 20000 });
  await client.connect();

  const who = await client.query('SELECT current_user, current_database()');
  console.log(`connected as ${who.rows[0].current_user}@${who.rows[0].current_database}`);

  // The same precondition db-apply enforces. A table nothing created is a disagreement between
  // the database and the migrations, and applying more migrations on top of a disagreement is
  // how a schema ends up matching no migration at all.
  const standing = await client.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname = 'public'
        AND c.relname NOT LIKE 'google_db_advisor%' AND c.relname NOT LIKE 'hypopg%'`
  );
  const unaccounted = tablesNoMigrationCreates(
    standing.rows.map((r) => r.name as string),
    tablesCreatedByMigrations('drizzle').tables
  );
  if (unaccounted.length > 0) {
    console.error(
      `\nREFUSING: ${unaccounted.length} table(s) exist that no migration creates: ` +
        `${unaccounted.join(', ')}.\n` +
        '  Either a migration was deleted after it ran, or something created them outside the\n' +
        '  migrations. One of the two records is wrong and this cannot tell which.'
    );
    await client.end();
    process.exit(2);
  }

  const before = await appliedCount(client);
  await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  const after = await appliedCount(client);

  console.log(`applied migrations: ${before} -> ${after}`);
  console.log(after === before ? 'already up to date.' : `${after - before} migration(s) applied.`);
  await client.end();
})().catch((e: Error) => {
  console.error('FAILED: ' + e.message);
  process.exit(1);
});

async function appliedCount(client: pg.Client): Promise<number> {
  const present = await client.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`
  );
  if (present.rows[0].present !== true) return 0;
  const n = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  return n.rows[0].n;
}
