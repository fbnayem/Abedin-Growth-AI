import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifiedPgOptions, describePlan, resolveTlsPlan } from '../server/db/tls';
import { migrationFilesInOrder } from './lib/migration-tables';
import { downHeaderOf, hasDown, readDown } from './lib/migration-reverse';
import { planRollbackStep } from './lib/rollback-plan';
import 'dotenv/config';

/**
 * S5 — roll the schema back one migration at a time, as the owner role, with the reverse
 * checked against its up before anything runs.
 *
 * drizzle's migrator is forward-only and records what it applied in drizzle.__drizzle_migrations
 * (one row per migration, `created_at` = the journal's `when`). This script runs the matching
 * file under drizzle/down/ and deletes that row, in one transaction per step, so the migrator's
 * view of the database and the database agree afterwards.
 *
 * It refuses, in this order:
 *   - without MIGRATION_DATABASE_URL: rollbacks are DDL and run as the owner, never the app role;
 *   - when the database is not at a state the journal describes (applied count ≠ journal length
 *     minus what has already been rolled back here) — a rollback from an unknown state lands in
 *     another unknown state;
 *   - when a step has no down migration;
 *   - when the down does not invert its up (scripts/lib/migration-reverse.ts);
 *   - when the down declares DROPS_DATA and --allow-data-loss was not passed. Before asking for
 *     that flag it prints the row counts of the tables the down names, so the operator decides
 *     with the number in front of them, not the category.
 *
 * Dry run unless --confirm. Usage:
 *   tsx scripts/db-rollback.ts [--steps=1] [--confirm] [--allow-data-loss]
 */

const STEPS = Number((process.argv.find((a) => a.startsWith('--steps=')) ?? '--steps=1').split('=')[1]);
const CONFIRM = process.argv.includes('--confirm');
const ALLOW_DATA_LOSS = process.argv.includes('--allow-data-loss');

function fail(message: string): never {
  console.error('\nREFUSING: ' + message);
  process.exit(2);
}

if (!Number.isInteger(STEPS) || STEPS < 1) fail('--steps must be a whole number of 1 or more.');

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  fail('MIGRATION_DATABASE_URL is not set. A rollback is DDL and runs as the owner role, never as the application role.');
}

const journal = JSON.parse(readFileSync(join('drizzle', 'meta', '_journal.json'), 'utf8')) as {
  entries: { idx: number; when: number; tag: string }[];
};
const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
const files = migrationFilesInOrder('drizzle');

(async () => {
  console.log(describePlan(resolveTlsPlan()));
  const client = new pg.Client({ ...verifiedPgOptions(url), connectionTimeoutMillis: 20000 });
  await client.connect();
  const who = await client.query('SELECT current_user, current_database()');
  console.log(`connected as ${who.rows[0].current_user}@${who.rows[0].current_database}`);
  if (!CONFIRM) console.log('\n--- DRY RUN. Nothing below has been executed. Re-run with --confirm. ---');

  const present = await client.query(`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`);
  if (present.rows[0].present !== true) fail('drizzle.__drizzle_migrations does not exist; nothing has been migrated through the migrator.');
  const applied = await client.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at');
  const appliedWhens = applied.rows.map((r) => Number(r.created_at));
  const appliedCount = appliedWhens.length;
  if (appliedCount > entries.length) fail(`${appliedCount} migrations applied but the journal has ${entries.length}; the database is ahead of this checkout.`);
  for (let i = 0; i < appliedCount; i++) {
    if (appliedWhens[i] !== entries[i].when) {
      fail(`applied migration ${i} has created_at ${appliedWhens[i]}, the journal says ${entries[i].when} (${entries[i].tag}); the database is not at a state this journal describes.`);
    }
  }
  if (STEPS > appliedCount) fail(`--steps=${STEPS} but only ${appliedCount} migration(s) are applied.`);
  console.log(`applied: ${appliedCount} of ${entries.length}; rolling back ${STEPS}`);

  for (let step = 0; step < STEPS; step++) {
    const idx = appliedCount - 1 - step;
    const entry = entries[idx];
    const upFile = files[idx];
    const up = readFileSync(join('drizzle', upFile), 'utf8');
    const down = hasDown(entry.tag) ? readDown(entry.tag) : null;

    // The row counts a data-dropping reverse would affect, printed BEFORE the decision so the
    // operator reads the number and not the category. Only the database can answer this part.
    if (down !== null) {
      let header: ReturnType<typeof downHeaderOf> | null = null;
      try {
        header = downHeaderOf(down);
      } catch {
        header = null;
      }
      if (header !== null && header.data === 'DROPS_DATA') {
        console.log(`\n[${step + 1}/${STEPS}] ${entry.tag} — DROPS_DATA; rows in the tables it names:`);
        const tables = [...new Set(header.affects.map((a) => a.split('.')[0]))];
        for (const t of tables) {
          const exists = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`public.${t}`]);
          if (exists.rows[0].present !== true) {
            console.log(`    ${t}: (not present)`);
            continue;
          }
          const n = await client.query(`SELECT count(*)::bigint AS n FROM "public"."${t}"`);
          console.log(`    ${t}: ${n.rows[0].n} row(s)`);
        }
      }
    }

    // The decision, as a value (scripts/lib/rollback-plan.ts). Executed if ok; printed if not.
    const plan = planRollbackStep({ tag: entry.tag, up, down, allowDataLoss: ALLOW_DATA_LOSS });
    if (plan.ok === false) fail(plan.reason);
    console.log(
      `\n[${step + 1}/${STEPS}] ${entry.tag} — ${plan.header.data}` +
        (plan.dataOnly.length ? ` (${plan.dataOnly.length} data-only statement(s) in the up have no reverse)` : '')
    );

    const statements = plan.statements;
    for (const s of statements) console.log('    ' + s.split('\n')[0].slice(0, 110));
    if (!CONFIRM) continue;

    await client.query('BEGIN');
    try {
      for (const s of statements) await client.query(s);
      const del = await client.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = $1', [entry.when]);
      if (del.rowCount !== 1) throw new Error(`expected to delete one journal row for ${entry.tag}, deleted ${del.rowCount}`);
      await client.query('COMMIT');
      console.log(`    rolled back ${entry.tag}`);
    } catch (e: any) {
      await client.query('ROLLBACK');
      fail(`${entry.tag}: ${e?.message ?? e}. The transaction was rolled back; the database is unchanged.`);
    }
  }

  const after = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  console.log(`\napplied migrations now: ${after.rows[0].n}`);
  await client.end();
})().catch((e: Error) => {
  console.error('FAILED: ' + e.message);
  process.exit(1);
});
