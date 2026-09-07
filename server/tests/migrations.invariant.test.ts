import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
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
    expect(latest.get('ai_run_logs')?.has('prompt_hash')).toBe(true);
    expect(latest.get('ai_run_logs')?.has('context_hash')).toBe(true);
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
