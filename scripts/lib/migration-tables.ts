/**
 * Which tables do the migrations create?
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/db-apply.ts` drops the application tables and then replays every migration from
 * nothing. It took its drop list from the backup manifest — the tables that existed when the
 * backup was taken. That is a record of the past, and the migrations are a statement about
 * what is about to be created. The two happened to be the same set on the day the script was
 * written, and the script worked.
 *
 * The first run created six tables the backup predated. The second run dropped the fourteen it
 * knew about, left those six standing, and migration 0002 failed on
 *
 *     relation "customer_commitments" already exists
 *
 * inside drizzle's transaction, which rolled the whole thing back — leaving a database with
 * six orphan tables, an empty journal, and no `organizations` at all. A script that is
 * destructive, is meant to be re-runnable, and works exactly once.
 *
 * So the drop list is now derived from the same files that do the creating. If a migration
 * adds a table, it is in the drop set the moment the file exists, with nobody remembering to
 * add it anywhere.
 *
 * WHAT IT UNDERSTANDS, AND WHAT IT REFUSES
 * ----------------------------------------
 * CREATE TABLE, DROP TABLE and ALTER TABLE ... RENAME TO, applied in journal order. It does
 * not try to understand SQL in general. Instead it counts how many of those three phrases each
 * file contains and how many it managed to parse, and throws when the two disagree — so a
 * statement written in a shape it does not handle stops the caller rather than silently
 * shrinking the drop set. An under-reported drop set is exactly the failure above.
 *
 * `tsconfig.json` excludes `scripts`, so nothing here is type-checked on its own. It is
 * imported by `server/tests/migrations.invariant.test.ts`, which is checked, and that pulls
 * this file into the graph.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

export interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
}

/** The migration files, in the order the journal says they are applied. */
export function migrationFilesInOrder(dir = 'drizzle'): string[] {
  const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: MigrationJournalEntry[];
  };
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.tag + '.sql');
}

/**
 * A quoted identifier may hold anything but a quote; an unquoted one is a word. Written this
 * way rather than as `"?(\w+)"?` because that form reads `CREATE TABLE public."contacts"` as a
 * table called `public` and `"my table"` as one called `my` — parsing something, silently, and
 * wrongly. Both are legal SQL and neither would trip a count check.
 */
const IDENT = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const QUALIFIED = `(?:${IDENT}\\s*\\.\\s*)?(${IDENT})`;

const CREATE = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${QUALIFIED}`, 'gi');
const DROP = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}`, 'gi');
const RENAME = new RegExp(
  `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${QUALIFIED}\\s+RENAME\\s+TO\\s+(${IDENT})`,
  'gi'
);

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s);

/**
 * How many times a phrase appears at all, whether or not the patterns above could parse it.
 *
 * This counts occurrences in comments and string literals too, so a migration that merely
 * mentions CREATE TABLE in a comment makes this throw. That is the safe direction: it stops the
 * caller and asks, rather than quietly returning a drop set with a table missing from it.
 */
function occurrences(sql: string, phrase: RegExp): number {
  return (sql.match(phrase) ?? []).length;
}

export interface MigrationTables {
  /** Every table standing after the last migration, sorted. */
  readonly tables: readonly string[];
  /** What each file did, for a caller that wants to say where a table came from. */
  readonly createdIn: ReadonlyMap<string, string>;
  /**
   * Every table any migration has EVER created, sorted, including ones a later migration drops
   * (S5: 0008 drops ai_run_logs). This is the set to check a standing database against — a
   * database one migration behind still holds the table the pending migration removes, and that
   * table is accounted for, not foreign. It is also the set db-apply must drop to rebuild from
   * nothing, or the replay of 0001 meets a table that already exists.
   */
  readonly everCreated: readonly string[];
}

/**
 * Replay the table-level effects of every migration in order.
 *
 * @throws if a file contains a CREATE TABLE / DROP TABLE / RENAME TO this cannot parse, or
 *         creates a table that already exists, or drops or renames one that does not — each of
 *         which means the migrations themselves would fail against an empty database.
 */
export function tablesCreatedByMigrations(dir = 'drizzle'): MigrationTables {
  const standing = new Set<string>();
  const createdIn = new Map<string, string>();
  const everCreated = new Set<string>();

  for (const file of migrationFilesInOrder(dir)) {
    const sql = readFileSync(join(dir, file), 'utf8');

    const creates = [...sql.matchAll(CREATE)];
    const drops = [...sql.matchAll(DROP)];
    const renames = [...sql.matchAll(RENAME)];

    // The self-check. A phrase this cannot parse must stop the caller, not be skipped.
    const expectedCreates = occurrences(sql, /CREATE\s+TABLE/gi);
    const expectedDrops = occurrences(sql, /DROP\s+TABLE/gi);
    const expectedRenames = occurrences(sql, /RENAME\s+TO/gi);
    if (creates.length !== expectedCreates) {
      throw new Error(
        `[migration-tables] ${file}: ${expectedCreates} CREATE TABLE statements, ` +
          `${creates.length} parsed. The drop set derived from this file would be incomplete.`
      );
    }
    if (drops.length !== expectedDrops) {
      throw new Error(
        `[migration-tables] ${file}: ${expectedDrops} DROP TABLE statements, ${drops.length} parsed.`
      );
    }
    if (renames.length !== expectedRenames) {
      throw new Error(
        `[migration-tables] ${file}: ${expectedRenames} RENAME TO statements, ` +
          `${renames.length} parsed as a table rename. A column rename reads the same to a ` +
          `reader and not to this — check ALTER TABLE ... RENAME COLUMN.`
      );
    }

    for (const m of creates) {
      const name = unquote(m[1]);
      if (standing.has(name)) {
        throw new Error(
          `[migration-tables] ${file} creates "${name}", which an earlier migration already ` +
            `created. Replayed from nothing these migrations would fail.`
        );
      }
      standing.add(name);
      createdIn.set(name, file);
      everCreated.add(name);
    }
    for (const m of drops) {
      const name = unquote(m[1]);
      if (!standing.has(name)) {
        throw new Error(`[migration-tables] ${file} drops "${name}", which nothing created.`);
      }
      standing.delete(name);
      createdIn.delete(name);
    }
    for (const m of renames) {
      const from = unquote(m[1]);
      const to = unquote(m[2]);
      if (!standing.has(from)) {
        throw new Error(`[migration-tables] ${file} renames "${from}", which nothing created.`);
      }
      standing.delete(from);
      standing.add(to);
      createdIn.set(to, createdIn.get(from) ?? file);
      createdIn.delete(from);
    }
  }

  return { tables: [...standing].sort(), createdIn, everCreated: [...everCreated].sort() };
}

/**
 * The tables standing in a live database that no migration accounts for.
 *
 * A separate exported function rather than three lines inside `db-apply.ts` so that the
 * decision can be tested without a database. What is left in the script is the wiring — read
 * the catalogue, call this, stop if it returns anything — and that part is only asserted by
 * reading the source, which is recorded where the mutation testing for this change is.
 *
 * Sorted, because it is printed in a refusal that someone has to act on and an order that
 * changes between runs makes two runs look like two different problems.
 */
export function tablesNoMigrationCreates(
  standing: readonly string[],
  created: readonly string[]
): string[] {
  return [...standing].filter((t) => !created.includes(t)).sort();
}
