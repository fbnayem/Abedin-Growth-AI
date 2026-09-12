import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { store } from '../store';

/**
 * S48 — REFUSING TO ACT WHEN THE SCHEMA IS NOT THE ONE THIS BUILD WAS WRITTEN AGAINST.
 *
 * WHAT WAS MISSING
 * ----------------
 * S48 landed payload versioning, migration ordering and a consumer that dead-letters a job it
 * cannot parse. Its own remainder said: *nothing yet refuses to serve when the schema is behind
 * the build.* `/api/health` reported `expectsMigration` — the last migration this build knows
 * about — and then answered `status: "ok"` regardless of whether that migration had been
 * applied. Reporting a fact beside a verdict that ignores it is worse than reporting neither.
 *
 * The scenario is ordinary, not exotic. A rolling deploy puts new code on a node before the
 * migration job finishes; a rollback returns old code to a database that has already moved on.
 * In the first case every query for a column that does not exist yet fails at runtime, one
 * request at a time, after the deploy reported success. In the second the code silently ignores
 * columns it does not know about — which is the quieter and worse of the two, because a write
 * that drops a field nothing reads is indistinguishable from a field nobody set.
 *
 * WHY COUNTS AND NOT TAGS
 * -----------------------
 * Drizzle's `drizzle.__drizzle_migrations` stores a hash and a timestamp per applied migration,
 * not the journal tag. So the comparison available is how MANY have been applied against how
 * many this build carries — the same basis `scripts/db-verify.ts` uses. It cannot detect a
 * database at the same count via a different path, and that is stated rather than implied away:
 * this catches ahead/behind, which is what a deploy gets wrong, not divergence.
 *
 * WHAT A MISMATCH DOES
 * --------------------
 * It does NOT refuse to boot. A transient database failure at startup would then brick a
 * deployment that is otherwise fine, and a control that takes the whole service down for a
 * blip gets removed. Instead:
 *
 *   - `/api/health` reports the real state and stops saying "ok".
 *   - The action gateway refuses irreversible actions.
 *
 * That split is deliberate. Serving a read on a mismatched schema is a bad idea; SENDING MAIL
 * on one is an irreversible act taken on data this build cannot read correctly. The read may be
 * wrong and recoverable; the send is neither.
 *
 * UNKNOWN REFUSES (§14). "We could not ask the database which migrations it has" is not "it has
 * the right ones."
 */

export const SCHEMA_STATES = ['MATCHED', 'DATABASE_BEHIND', 'DATABASE_AHEAD', 'UNKNOWN'] as const;
export type SchemaState = (typeof SCHEMA_STATES)[number];

export interface SchemaCompatibility {
  readonly state: SchemaState;
  /** How many migrations this build carries. `null` when the journal could not be read. */
  readonly expected: number | null;
  /** How many the database reports applied. `null` when it could not be asked. */
  readonly applied: number | null;
  /** Why, in a sentence an operator can act on. */
  readonly detail: string;
}

/**
 * Compare what the build carries with what the database reports.
 *
 * Pure, so every branch can be held still by a test — including the two that are hardest to
 * produce on purpose, a database ahead of the code and a count that cannot be read at all.
 */
export function compareMigrations(
  expected: number | null,
  applied: number | null
): SchemaCompatibility {
  if (expected === null || applied === null) {
    return {
      state: 'UNKNOWN',
      expected,
      applied,
      detail:
        'Could not establish whether the database schema matches this build. Refusing ' +
        'irreversible actions rather than assuming it does.',
    };
  }
  if (applied < expected) {
    return {
      state: 'DATABASE_BEHIND',
      expected,
      applied,
      detail:
        `The database has ${applied} of the ${expected} migrations this build expects. Queries ` +
        'for anything the missing migrations add will fail at runtime. Run `npm run migrate`.',
    };
  }
  if (applied > expected) {
    return {
      state: 'DATABASE_AHEAD',
      expected,
      applied,
      detail:
        `The database has ${applied} migrations and this build carries ${expected}. This build ` +
        'is older than the schema — most likely a rollback that left the database forward. It ' +
        'cannot see columns it does not know about, so a write here may silently drop fields.',
    };
  }
  return {
    state: 'MATCHED',
    expected,
    applied,
    detail: `The database has all ${expected} migrations this build expects.`,
  };
}

/** Only MATCHED may take an irreversible action. Written positively so a new state fails closed. */
export function schemaPermitsIrreversibleActions(compatibility: SchemaCompatibility): boolean {
  return compatibility.state === 'MATCHED';
}

/**
 * How many migrations this build carries, or null if the journal cannot be read.
 *
 * The journal is parsed here rather than imported from `scripts/lib/migration-tables`, which
 * already has a reader. `scripts/` is excluded from `tsconfig.json` and is build-time tooling;
 * importing it from `server/` would pull a build-time module into the production bundle and
 * make the runtime depend on the shape of a script. Six lines is the cheaper coupling.
 */
export function expectedMigrationCount(dir = 'drizzle'): number | null {
  try {
    const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8')) as {
      entries?: unknown[];
    };
    // A journal without an `entries` array is unreadable, NOT empty. Returning 0 here would
    // make an empty database match it, which is the same §14 inversion in a different shape.
    return Array.isArray(journal.entries) ? journal.entries.length : null;
  } catch {
    return null;
  }
}

/**
 * The count out of a result set, or null.
 *
 * Exported and separate from the query because it is the part that decides, and it survived a
 * mutant while it was inline: returning 0 for an unreadable row rather than null makes an empty
 * database MATCH a build that expects nothing, and makes every other build BEHIND for the wrong
 * reason. A number that could not be read is not zero.
 */
export function migrationCountFrom(rows: unknown): number | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const first = rows[0];
  if (first === null || typeof first !== 'object') return null;
  const n = (first as Record<string, unknown>).n;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
}

async function appliedMigrationCount(): Promise<number | null> {
  if (!store) return null;
  try {
    const result = await store.pool.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations'
    );
    return migrationCountFrom(result.rows);
  } catch {
    // The table not existing is itself an answer — nothing has been migrated through the
    // migrator — but it is reported as UNKNOWN rather than as zero, because a permission error
    // and an empty database produce the same exception here and they are not the same fact.
    return null;
  }
}

/**
 * The cached compatibility, and why it is cached.
 *
 * This is consulted on the dispatch path. A database round trip per send would be affordable,
 * but it would also mean a database blip converts into a refused send rather than into a
 * slightly stale answer — and the answer only changes when somebody deploys or migrates.
 *
 * A GOOD RESULT IS CACHED FOR LONGER THAN A BAD ONE. Once mismatched, the state is re-checked
 * often, so recovery is noticed quickly; while matched, it is re-checked rarely. The asymmetry
 * is the point: being slow to notice that things are fine costs nothing.
 */
const GOOD_TTL_MS = 60_000;
const BAD_TTL_MS = 5_000;

let cached: { at: number; value: SchemaCompatibility } | null = null;

export function resetSchemaCompatibilityCache(): void {
  cached = null;
}

export async function schemaCompatibility(now: number = Date.now()): Promise<SchemaCompatibility> {
  if (cached) {
    const ttl = cached.value.state === 'MATCHED' ? GOOD_TTL_MS : BAD_TTL_MS;
    if (now - cached.at < ttl) return cached.value;
  }
  const value = compareMigrations(expectedMigrationCount(), await appliedMigrationCount());
  cached = { at: now, value };
  return value;
}
