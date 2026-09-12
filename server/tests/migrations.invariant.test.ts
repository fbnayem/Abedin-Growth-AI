import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  tablesCreatedByMigrations,
  tablesNoMigrationCreates,
} from '../../scripts/lib/migration-tables';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * THE MIGRATIONS MUST DESCRIBE THE SCHEMA THE CODE QUERIES.
 *
 * This file exists because they did not, and nothing noticed.
 *
 * Three commits changed `server/db/schema.ts` and none generated a migration: the P1.8 run-log
 * columns, the P1.9 time-correctness pass, and the S16/S35 `sanitized_html_body` rename. The
 * checked-in migrations still described the schema as it was on 2026-09-06.
 *
 * The failure mode is specific and quiet. `drizzle-kit check` passed the whole time — it
 * validates that the migrations are consistent WITH EACH OTHER, not that they produce the
 * schema the application expects. `tsc` passed, because TypeScript checks the code against
 * `schema.ts` and never looks at the SQL. Every test passed, because none of them touches a
 * database. So the entire gate was green over a migration set that, applied to an empty
 * database, would build `messages.sanitized_html_body` and leave every query for
 * `raw_html_body` to fail at runtime — after the migration reported success.
 *
 * That is the same shape as the defects the addendum is mostly about: a step that completes,
 * reports success, and leaves untrue the thing it was supposed to establish.
 */

type SnapshotColumn = { name: string; type: string; notNull?: boolean; default?: string };
type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { name: string; columns: Record<string, SnapshotColumn> }>;
};
type Journal = { entries: { idx: number; version: string; when: number; tag: string }[] };

const journal: Journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));

const snapshotFor = (idx: number): Snapshot =>
  JSON.parse(readFileSync(`drizzle/meta/${String(idx).padStart(4, '0')}_snapshot.json`, 'utf8'));

/** What `schema.ts` actually declares, read through drizzle rather than parsed out of the file. */
function liveSchema(): Map<string, Map<string, { type: string; notNull: boolean }>> {
  const out = new Map<string, Map<string, { type: string; notNull: boolean }>>();
  for (const value of Object.values(schema)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value as any);
    const cols = new Map<string, { type: string; notNull: boolean }>();
    for (const c of cfg.columns) cols.set(c.name, { type: c.getSQLType(), notNull: c.notNull });
    out.set(cfg.name, cols);
  }
  return out;
}

function snapshotSchema(s: Snapshot): Map<string, Map<string, { type: string; notNull: boolean }>> {
  const out = new Map<string, Map<string, { type: string; notNull: boolean }>>();
  for (const t of Object.values(s.tables)) {
    const cols = new Map<string, { type: string; notNull: boolean }>();
    for (const c of Object.values(t.columns)) {
      cols.set(c.name, { type: c.type, notNull: c.notNull === true });
    }
    out.set(t.name, cols);
  }
  return out;
}

// ===========================================================================
describe('1. the latest migration describes exactly what schema.ts declares', () => {
  const live = liveSchema();
  const latest = snapshotSchema(snapshotFor(journal.entries.length - 1));

  /**
   * A floor, so this suite cannot pass by reading nothing. If `schema.ts` ever exports zero
   * tables — a bad refactor, a broken import — every comparison below becomes vacuously true.
   */
  it('reads a real schema from both sides', () => {
    expect(live.size).toBeGreaterThanOrEqual(20);
    expect(latest.size).toBe(live.size);
  });

  it('no table is in one and not the other', () => {
    const onlyInCode = [...live.keys()].filter((t) => !latest.has(t));
    const onlyInMigrations = [...latest.keys()].filter((t) => !live.has(t));
    expect({ onlyInCode, onlyInMigrations }).toEqual({ onlyInCode: [], onlyInMigrations: [] });
  });

  it('every column matches by name, type and nullability', () => {
    const drift: string[] = [];
    for (const [table, cols] of live) {
      const before = latest.get(table);
      if (before === undefined) continue;
      for (const [name, def] of cols) {
        const was = before.get(name);
        if (was === undefined) {
          drift.push(`${table}.${name} is in schema.ts and not in the migrations`);
          continue;
        }
        if (was.type !== def.type) {
          drift.push(`${table}.${name}: migrations say ${was.type}, schema.ts says ${def.type}`);
        }
        if (was.notNull !== def.notNull) {
          drift.push(`${table}.${name}: notNull ${was.notNull} in migrations, ${def.notNull} in schema.ts`);
        }
      }
      for (const name of before.keys()) {
        if (!cols.has(name)) drift.push(`${table}.${name} is in the migrations and not in schema.ts`);
      }
    }
    // Printed in full rather than counted: the point of this failing is to say what to migrate.
    expect(drift).toEqual([]);
  });

  /**
   * The specific drift that was found, named so a regression is recognisable rather than just
   * being one line in a list of ninety.
   */
  it('the columns that were actually missing are present', () => {
    expect(latest.get('messages')?.has('raw_html_body')).toBe(true);
    expect(latest.get('messages')?.has('html_as_text')).toBe(true);
    expect(latest.get('messages')?.has('sanitized_html_body')).toBe(false);
    expect(latest.get('meetings')?.has('start_at_utc')).toBe(true);
    // ai_run_logs gained these in 0005 and was dropped by 0008 (S22, S5): the columns are checked
    // on the last rung that holds the table, and the top rung is checked to have let it go.
    const lastWithTable = snapshotSchema(snapshotFor(7));
    expect(lastWithTable.get('ai_run_logs')?.has('prompt_hash')).toBe(true);
    expect(lastWithTable.get('ai_run_logs')?.has('context_hash')).toBe(true);
    expect(latest.has('ai_run_logs')).toBe(false);
  });
});

// ===========================================================================
describe('2. the migration set is internally coherent', () => {
  it('the journal is contiguous and ordered', () => {
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      if (i > 0) expect(e.when).toBeGreaterThan(journal.entries[i - 1].when);
    });
  });

  it('every journal entry has both its SQL and its snapshot on disk', () => {
    for (const e of journal.entries) {
      expect(existsSync(`drizzle/${e.tag}.sql`), `missing drizzle/${e.tag}.sql`).toBe(true);
      const snap = `drizzle/meta/${String(e.idx).padStart(4, '0')}_snapshot.json`;
      expect(existsSync(snap), `missing ${snap}`).toBe(true);
    }
  });

  it('no SQL file on disk is missing from the journal', () => {
    const onDisk = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    const inJournal = journal.entries.map((e) => e.tag).sort();
    // A migration file that no journal entry names is never applied, and its absence from a
    // deployed database is invisible.
    expect(onDisk).toEqual(inJournal);
  });

  it('each snapshot chains to the one before it', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = snapshotFor(i - 1);
      const cur = snapshotFor(i);
      expect(cur.prevId, `snapshot ${i} does not chain to ${i - 1}`).toBe(prev.id);
      expect(cur.id).not.toBe(prev.id);
    }
  });
});

// ===========================================================================
describe('3. no migration is unsafe against a populated table', () => {
  const allSql = journal.entries.map((e) => ({
    tag: e.tag,
    sql: readFileSync(`drizzle/${e.tag}.sql`, 'utf8'),
  }));

  it('reads every migration file', () => {
    expect(allSql.length).toBe(journal.entries.length);
    expect(allSql.every((m) => m.sql.length > 0)).toBe(true);
  });

  /**
   * `ALTER COLUMN ... TYPE timestamptz` with no USING clause reinterprets each stored naive
   * value in the SESSION's TimeZone. It is correct only if that setting happens to be UTC —
   * invisible when true, and it silently shifts every row when false.
   *
   * P1.9 is in this repository because this exact class of error was already here once: an
   * offset applied twice, in the same direction. The zone gets stated, not inherited.
   */
  it('every conversion to timestamptz states the zone it is converting from', () => {
    const offenders: string[] = [];
    for (const m of allSql) {
      for (const statement of m.sql.split('--> statement-breakpoint')) {
        const line = statement.replace(/^\s*--[^\n]*$/gm, '').trim();
        if (!/ALTER\s+COLUMN[\s\S]*TYPE\s+timestamp\s+with\s+time\s+zone/i.test(line)) continue;
        if (!/AT\s+TIME\s+ZONE/i.test(line)) {
          offenders.push(`${m.tag}: ${line.slice(0, 110)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Adding a NOT NULL column with no default fails outright on a table with rows. On an empty
   * one it succeeds, so the migration passes in development and fails in production — the worst
   * available ordering.
   */
  it('no migration adds a NOT NULL column without a default', () => {
    const offenders: string[] = [];
    for (const m of allSql) {
      for (const statement of m.sql.split('--> statement-breakpoint')) {
        const line = statement.replace(/^\s*--[^\n]*$/gm, '').trim();
        if (!/ADD\s+COLUMN/i.test(line)) continue;
        if (!/NOT\s+NULL/i.test(line)) continue;
        if (/DEFAULT/i.test(line)) continue;
        offenders.push(`${m.tag}: ${line.slice(0, 110)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A column that leaves a table by DROP takes its rows with it. Where the same migration adds
   * a column of the same type, the intent was almost certainly a rename — and drizzle-kit
   * cannot tell the two apart without a TTY prompt, so a non-interactive `generate` cannot
   * produce this safely. It has to be a deliberate answer.
   */
  it('no migration drops a column, so no rename can be written as a discard', () => {
    const offenders: string[] = [];
    for (const m of allSql) {
      for (const statement of m.sql.split('--> statement-breakpoint')) {
        const line = statement.replace(/^\s*--[^\n]*$/gm, '').trim();
        if (/ALTER\s+TABLE[\s\S]*DROP\s+COLUMN/i.test(line)) offenders.push(`${m.tag}: ${line.slice(0, 110)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the two column moves are renames, not drop-and-recreate', () => {
    const sql = allSql.map((m) => m.sql).join('\n');
    expect(sql).toMatch(/ALTER TABLE "messages" RENAME COLUMN "sanitized_html_body" TO "raw_html_body"/);
    expect(sql).toMatch(/ALTER TABLE "meetings" RENAME COLUMN "scheduled_time" TO "start_at_utc"/);
  });
});

// ===========================================================================
/**
 * WHAT A DESTRUCTIVE SCRIPT IS ALLOWED TO BELIEVE ABOUT WHAT IT IS DROPPING.
 *
 * `scripts/db-apply.ts` drops the application tables and replays every migration from
 * nothing. Its drop list came from the backup manifest — the tables that existed when the
 * backup was taken. The backup is a record of the past; the migrations are a statement about
 * what is about to be created. On the day the script was written the two sets were equal, and
 * it worked.
 *
 * Its own first run made them unequal. Migrations 0002 and 0003 create six tables the backup
 * predated, so the second run dropped the fourteen the manifest listed, left those six
 * standing, and drizzle failed on
 *
 *     relation "customer_commitments" already exists
 *
 * inside the transaction wrapping all six migrations — which rolled every one of them back.
 * What survived was six orphan tables, an empty journal, and no `organizations` at all: a
 * database emptier than the one the script had been pointed at, and no verification output,
 * because the script verifies at step 6 and died at step 3.
 *
 * The tests below are about the derivation, not about that database. A drop set read from a
 * record of the past is wrong even on the run where it happens to agree.
 */
describe('4. the drop set is derived from what the migrations create', () => {
  const derived = tablesCreatedByMigrations('drizzle');

  /**
   * Both directions. A table in schema.ts that no migration creates fails at runtime on first
   * query; a table the migrations create that schema.ts has forgotten is dropped by db-apply
   * and then recreated with nothing reading it — and neither shows up as a type error.
   */
  it('the migrations create exactly the tables schema.ts declares', () => {
    const declared = [...liveSchema().keys()].sort();
    expect(derived.tables.filter((t) => !declared.includes(t))).toEqual([]);
    expect(declared.filter((t) => !derived.tables.includes(t))).toEqual([]);
  });

  /**
   * The regression itself. These six are the tables migrations 0002 and 0003 add — the ones
   * the manifest-derived list could not know about, because they did not exist when the
   * backup was taken. Named individually rather than counted, so that a change which drops
   * one of them out of the drop set has to say so here.
   */
  it('includes the tables added after the backup was taken', () => {
    for (const table of [
      'customer_commitments',
      'oauth_connections',
      'objection_ledger',
      'question_ledger',
      'quote_snapshots',
      'campaign_recipients',
    ]) {
      expect(derived.tables).toContain(table);
      expect(derived.createdIn.get(table)).toMatch(/^000[23]_/);
    }
  });

  /**
   * The test that makes the previous one mean something. Everything above would still pass if
   * db-apply went back to reading `manifest.tables`, because a unit test cannot see a backup
   * directory that lives outside the repository.
   */
  it('db-apply takes its drop list from the migrations, not from the backup manifest', () => {
    const applySrc = readFileSync('scripts/db-apply.ts', 'utf8');
    expect(applySrc).toMatch(/const APP_TABLES = tablesCreatedByMigrations\(/);
    expect(applySrc).not.toMatch(/const APP_TABLES = manifest\.tables/);
  });

  /**
   * The precondition that stops the script before a DROP when the database holds something
   * the migrations do not explain.
   *
   * The decision is a function so it can be exercised here. What remains in `db-apply.ts` is
   * the wiring — read the catalogue, call this, refuse if it returns anything — and that is
   * asserted below by reading the source, because running it needs a live database. A mutant
   * that disables the `if` while leaving the call in place survives; it is recorded rather
   * than claimed dead.
   */
  it('a table no migration creates is reported, whatever else is standing', () => {
    expect(
      tablesNoMigrationCreates(['contacts', 'leftover', 'messages'], ['contacts', 'messages'])
    ).toEqual(['leftover']);
  });

  it('a database holding exactly what the migrations create reports nothing', () => {
    expect(tablesNoMigrationCreates([...derived.tables], derived.tables)).toEqual([]);
  });

  /**
   * The direction that is NOT a refusal. A migration whose table has not been created yet is
   * the ordinary state of a database about to be migrated; only the other direction is a
   * question this script cannot answer.
   */
  it('a table the migrations create but the database lacks is not reported', () => {
    expect(tablesNoMigrationCreates([], ['contacts', 'messages'])).toEqual([]);
  });

  it('the report is ordered, so two runs of the same problem read the same', () => {
    expect(tablesNoMigrationCreates(['zeta', 'alpha', 'mid'], [])).toEqual(['alpha', 'mid', 'zeta']);
  });

  /**
   * And the precondition that stops the script before a DROP when the database holds
   * something the migrations do not explain.
   */
  it('db-apply refuses to drop a database holding tables no migration creates', () => {
    const applySrc = readFileSync('scripts/db-apply.ts', 'utf8');
    expect(applySrc).toMatch(/unaccounted/);
    expect(applySrc).toMatch(/fail\(\s*\n?\s*`\$\{unaccounted\.length\} table\(s\) exist/);
  });
});

// ===========================================================================
/**
 * The parser behind that drop set, on inputs the real migrations do not contain.
 *
 * A parser feeding a DROP has one failure mode that matters: returning a set with something
 * missing from it. Returning too much is caught by the equality test above; returning too
 * little is what happened, and it is invisible — the script runs, drops what it was told, and
 * the gap only appears later as an error from somewhere else.
 */
describe('5. the drop-set parser refuses rather than under-reporting', () => {
  /** A throwaway migration directory holding exactly the files named. */
  const fixture = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'migtables-'));
    mkdirSync(join(dir, 'meta'));
    const tags = Object.keys(files).map((f) => f.replace(/\.sql$/, ''));
    writeFileSync(
      join(dir, 'meta/_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: tags.map((tag, idx) => ({ idx, version: '7', when: idx, tag, breakpoints: true })),
      })
    );
    for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
    return dir;
  };

  it('reads a schema-qualified name as the table, not as the schema', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "public"."contacts" ("id" text);',
      '0001_b.sql': 'CREATE TABLE public.accounts ("id" text);',
    });
    expect(tablesCreatedByMigrations(dir).tables).toEqual(['accounts', 'contacts']);
  });

  it('reads a quoted name containing a space whole', () => {
    const dir = fixture({ '0000_a.sql': 'CREATE TABLE "two words" ("id" text);' });
    expect(tablesCreatedByMigrations(dir).tables).toEqual(['two words']);
  });

  /**
   * `RENAME COLUMN x TO y` and `RENAME TO y` differ by one word and rename different things.
   * Reading the first as a table rename would drop a real table out of the set and add one
   * that does not exist.
   */
  it('does not read a column rename as a table rename', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "messages" ("id" text);',
      '0001_b.sql': 'ALTER TABLE "messages" RENAME COLUMN "a" TO "b";',
    });
    expect(tablesCreatedByMigrations(dir).tables).toEqual(['messages']);
  });

  it('follows a table rename', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "old_name" ("id" text);',
      '0001_b.sql': 'ALTER TABLE "old_name" RENAME TO "new_name";',
    });
    const r = tablesCreatedByMigrations(dir);
    expect(r.tables).toEqual(['new_name']);
    expect(r.createdIn.get('new_name')).toBe('0000_a.sql');
  });

  it('a dropped table leaves the set', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "keep" ("id" text);\nCREATE TABLE "gone" ("id" text);',
      '0001_b.sql': 'DROP TABLE "gone";',
    });
    expect(tablesCreatedByMigrations(dir).tables).toEqual(['keep']);
  });

  /**
   * The self-check. A CREATE TABLE in a shape the patterns do not match must stop the caller.
   * Silently skipping it is the original bug in miniature: a drop set with a table missing.
   */
  it('throws when a CREATE TABLE cannot be parsed, rather than skipping it', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "fine" ("id" text);\nCREATE TABLE 9invalid ("id" text);',
    });
    expect(() => tablesCreatedByMigrations(dir)).toThrow(/2 CREATE TABLE statements, 1 parsed/);
  });

  /**
   * Replayed from nothing, these migrations would fail. Better to say so from a test than
   * from inside a transaction that has already rolled back the evidence.
   */
  it('throws when two migrations create the same table', () => {
    const dir = fixture({
      '0000_a.sql': 'CREATE TABLE "twice" ("id" text);',
      '0001_b.sql': 'CREATE TABLE "twice" ("id" text);',
    });
    expect(() => tablesCreatedByMigrations(dir)).toThrow(/already created/);
  });

  it('throws when a migration drops a table nothing created', () => {
    const dir = fixture({ '0000_a.sql': 'DROP TABLE "never_existed";' });
    expect(() => tablesCreatedByMigrations(dir)).toThrow(/which nothing created/);
  });
});
