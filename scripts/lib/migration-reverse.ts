import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S5 — does a down migration invert its up?
 *
 * A reverse that is merely present proves nothing; the rollback script must not run one that
 * would leave the schema somewhere other than where the previous migration left it. This module
 * reads both files as statements, reduces each statement to the EFFECT it has on the catalogue,
 * and checks that the down's effects are exactly the up's effects inverted. It is deliberately
 * structural — it says nothing about data — and the in-process round trip in
 * `migrationRollback.invariant.test.ts` is what proves the SQL actually does what the effects say.
 *
 * Every statement must be classified. A shape this cannot read stops the caller, because a
 * reverse checked against an incomplete reading of the up is a reverse that has not been checked.
 */

export type Effect =
  | { kind: 'table'; sign: 1 | -1; name: string }
  | { kind: 'column'; sign: 1 | -1; table: string; name: string }
  | { kind: 'constraint'; sign: 1 | -1; table: string; name: string }
  | { kind: 'index'; sign: 1 | -1; table: string | null; name: string }
  | { kind: 'notnull'; sign: 1 | -1; table: string; name: string }
  | { kind: 'type'; table: string; name: string; to: 'timestamptz' | 'timestamp' }
  | { kind: 'rename'; table: string; from: string; to: string }
  /** S4 — ENABLE/DISABLE and FORCE/NO FORCE ROW LEVEL SECURITY, as `enable` and `force`. */
  | { kind: 'rls'; sign: 1 | -1; table: string; name: 'enable' | 'force' }
  | { kind: 'policy'; sign: 1 | -1; table: string; name: string }
  | { kind: 'data'; description: string };

const RULES: { rx: RegExp; effect: (m: RegExpMatchArray) => Effect }[] = [
  { rx: /^CREATE TABLE "(\w+)"/, effect: (m) => ({ kind: 'table', sign: 1, name: m[1] }) },
  { rx: /^DROP TABLE (?:IF EXISTS )?"(\w+)"/, effect: (m) => ({ kind: 'table', sign: -1, name: m[1] }) },
  { rx: /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/, effect: (m) => ({ kind: 'constraint', sign: 1, table: m[1], name: m[2] }) },
  { rx: /^ALTER TABLE "(\w+)" DROP CONSTRAINT (?:IF EXISTS )?"(\w+)"/, effect: (m) => ({ kind: 'constraint', sign: -1, table: m[1], name: m[2] }) },
  { rx: /^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/, effect: (m) => ({ kind: 'column', sign: 1, table: m[1], name: m[2] }) },
  { rx: /^ALTER TABLE "(\w+)" DROP COLUMN "(\w+)"/, effect: (m) => ({ kind: 'column', sign: -1, table: m[1], name: m[2] }) },
  { rx: /^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" SET NOT NULL/, effect: (m) => ({ kind: 'notnull', sign: 1, table: m[1], name: m[2] }) },
  { rx: /^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" DROP NOT NULL/, effect: (m) => ({ kind: 'notnull', sign: -1, table: m[1], name: m[2] }) },
  {
    rx: /^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" TYPE timestamp with time zone USING "\w+" AT TIME ZONE 'UTC'/,
    effect: (m) => ({ kind: 'type', table: m[1], name: m[2], to: 'timestamptz' }),
  },
  {
    rx: /^ALTER TABLE "(\w+)" ALTER COLUMN "(\w+)" TYPE timestamp USING "\w+" AT TIME ZONE 'UTC'/,
    effect: (m) => ({ kind: 'type', table: m[1], name: m[2], to: 'timestamp' }),
  },
  { rx: /^ALTER TABLE "(\w+)" RENAME COLUMN "(\w+)" TO "(\w+)"/, effect: (m) => ({ kind: 'rename', table: m[1], from: m[2], to: m[3] }) },
  { rx: /^CREATE INDEX "(\w+)" ON "(\w+)"/, effect: (m) => ({ kind: 'index', sign: 1, table: m[2], name: m[1] }) },
  { rx: /^DROP INDEX (?:IF EXISTS )?"(\w+)"/, effect: (m) => ({ kind: 'index', sign: -1, table: null, name: m[1] }) },
  { rx: /^ALTER TABLE "(\w+)" ENABLE ROW LEVEL SECURITY/, effect: (m) => ({ kind: 'rls', sign: 1, table: m[1], name: 'enable' }) },
  { rx: /^ALTER TABLE "(\w+)" DISABLE ROW LEVEL SECURITY/, effect: (m) => ({ kind: 'rls', sign: -1, table: m[1], name: 'enable' }) },
  { rx: /^ALTER TABLE "(\w+)" FORCE ROW LEVEL SECURITY/, effect: (m) => ({ kind: 'rls', sign: 1, table: m[1], name: 'force' }) },
  { rx: /^ALTER TABLE "(\w+)" NO FORCE ROW LEVEL SECURITY/, effect: (m) => ({ kind: 'rls', sign: -1, table: m[1], name: 'force' }) },
  { rx: /^CREATE POLICY "(\w+)" ON "(\w+)"/, effect: (m) => ({ kind: 'policy', sign: 1, table: m[2], name: m[1] }) },
  { rx: /^DROP POLICY (?:IF EXISTS )?"(\w+)" ON "(\w+)"/, effect: (m) => ({ kind: 'policy', sign: -1, table: m[2], name: m[1] }) },
  { rx: /^UPDATE "?(\w+)"?/, effect: (m) => ({ kind: 'data', description: `UPDATE ${m[1]}` }) },
  { rx: /^DO \$\$/, effect: () => ({ kind: 'data', description: 'DO block' }) },
];

/** Split a migration file into statements, dropping comment-only lines that precede each. */
export function statementsOf(sql: string): string[] {
  return sql
    .replace(/\r\n/g, '\n')
    .split('--> statement-breakpoint')
    .map((chunk) => {
      const lines = chunk.split('\n');
      while (lines.length > 0 && (lines[0].trim() === '' || lines[0].trim().startsWith('--'))) lines.shift();
      return lines.join('\n').trim();
    })
    .filter((s) => s.length > 0);
}

export function effectOf(statement: string): Effect {
  for (const rule of RULES) {
    const m = statement.match(rule.rx);
    if (m) return rule.effect(m);
  }
  throw new Error(`[migration-reverse] unclassified statement: ${statement.slice(0, 120)}`);
}

export function effectsOf(sql: string): Effect[] {
  return statementsOf(sql).map(effectOf);
}

/** The catalogue effect of a statement, as a comparable key; `null` for data-only statements. */
function keyOf(e: Effect): string | null {
  switch (e.kind) {
    case 'table':
      return `table:${e.name}:${e.sign}`;
    case 'column':
      return `column:${e.table}.${e.name}:${e.sign}`;
    case 'constraint':
      return `constraint:${e.table}.${e.name}:${e.sign}`;
    case 'index':
      return `index:${e.name}:${e.sign}`;
    case 'notnull':
      return `notnull:${e.table}.${e.name}:${e.sign}`;
    case 'type':
      return `type:${e.table}.${e.name}:${e.to}`;
    case 'rename':
      return `rename:${e.table}:${e.from}->${e.to}`;
    case 'rls':
      return `rls:${e.table}.${e.name}:${e.sign}`;
    case 'policy':
      return `policy:${e.table}.${e.name}:${e.sign}`;
    case 'data':
      return null;
  }
}

/** What the inverse of an effect must look like. */
function inverseKey(e: Effect): string | null {
  switch (e.kind) {
    case 'table':
    case 'column':
    case 'constraint':
    case 'index':
    case 'notnull':
    case 'rls':
    case 'policy':
      return keyOf({ ...e, sign: e.sign === 1 ? -1 : 1 } as Effect);
    case 'type':
      return keyOf({ ...e, to: e.to === 'timestamptz' ? 'timestamp' : 'timestamptz' });
    case 'rename':
      return keyOf({ kind: 'rename', table: e.table, from: e.to, to: e.from });
    case 'data':
      return null;
  }
}

export interface ReverseVerdict {
  readonly ok: boolean;
  /** Effects of the up that the down does not invert. */
  readonly missing: string[];
  /** Effects in the down that invert nothing in the up. */
  readonly extra: string[];
  /** Data-only statements of the up, which have no reverse and are listed rather than hidden. */
  readonly dataOnly: string[];
}

/**
 * A DROP TABLE takes the table's constraints and indexes with it — they belong to the table. So
 * three things are not discrepancies:
 *
 *   - the up created T's constraint or index, and the down drops T whole without naming it
 *     (the drop inverts it);
 *   - the down drops T's constraint or index explicitly and THEN drops T (redundant, and exactly
 *     what a statement-by-statement reverse produces);
 *   - the up dropped T whole, and the down recreates T's constraint or index by name (the
 *     reverse of the CASCADE).
 *
 * A DROP INDEX names no table, so the table an index belongs to is read from the CREATE INDEX
 * on whichever side has it.
 */
function tableOf(e: Effect, indexTables: Map<string, string>): string | null {
  if (e.kind === 'constraint' || e.kind === 'rls' || e.kind === 'policy') return e.table;
  if (e.kind === 'index') return e.table ?? indexTables.get(e.name) ?? null;
  return null;
}

/** Does `down` invert `up`? A multiset comparison of catalogue effects, order-insensitive. */
export function downInvertsUp(up: string, down: string): ReverseVerdict {
  const upEffects = effectsOf(up);
  const downEffects = effectsOf(down);
  const dropped = (effects: Effect[]) =>
    new Set(effects.filter((e) => e.kind === 'table' && e.sign === -1).map((e) => (e as { name: string }).name));
  const tablesUpDrops = dropped(upEffects);
  const tablesDownDrops = dropped(downEffects);
  const indexTables = new Map<string, string>();
  for (const e of [...upEffects, ...downEffects]) {
    if (e.kind === 'index' && e.table !== null) indexTables.set(e.name, e.table);
  }
  const belongsToTableDroppedBy = (e: Effect, drops: Set<string>) => {
    const t = tableOf(e, indexTables);
    return t !== null && drops.has(t);
  };

  const wanted = new Map<string, number>();
  const dataOnly: string[] = [];
  for (const e of upEffects) {
    const k = inverseKey(e);
    if (k === null) {
      dataOnly.push((e as { description: string }).description);
      continue;
    }
    wanted.set(k, (wanted.get(k) ?? 0) + 1);
  }
  const extra: string[] = [];
  for (const e of downEffects) {
    const k = keyOf(e);
    if (k === null) continue;
    const n = wanted.get(k) ?? 0;
    if (n > 0) {
      wanted.set(k, n - 1);
      continue;
    }
    if (e.kind === 'constraint' || e.kind === 'index') {
      // Recreating what the up's table drop removed; or dropping explicitly what the down's own
      // table drop would remove anyway.
      if (e.sign === 1 && belongsToTableDroppedBy(e, tablesUpDrops)) continue;
      if (e.sign === -1 && belongsToTableDroppedBy(e, tablesDownDrops)) continue;
    }
    extra.push(k);
  }
  const missing: string[] = [];
  for (const [k, n] of wanted.entries()) {
    if (n === 0) continue;
    // Owed a "-1" on a constraint/index whose table the down drops whole: the drop pays it.
    const m = /^(constraint|index):(?:([^.]+)\.)?([^:]+):-1$/.exec(k);
    if (m) {
      const table = m[1] === 'constraint' ? m[2] : indexTables.get(m[3]) ?? null;
      if (table !== null && tablesDownDrops.has(table)) continue;
    }
    missing.push(n > 1 ? `${k} x${n}` : k);
  }
  return { ok: missing.length === 0 && extra.length === 0, missing, extra, dataOnly };
}

/** The header a down migration declares about itself. */
export interface DownHeader {
  readonly reverses: string;
  readonly data: 'SCHEMA_ONLY' | 'DROPS_DATA';
  readonly affects: string[];
}

export function downHeaderOf(sql: string): DownHeader {
  const text = sql.replace(/\r\n/g, '\n');
  const reverses = /^-- Reverses (\S+?)\.?$/m.exec(text)?.[1];
  const data = /^-- data: (SCHEMA_ONLY|DROPS_DATA)$/m.exec(text)?.[1] as DownHeader['data'] | undefined;
  const affects = /^-- affects: (.+)$/m.exec(text)?.[1];
  if (!reverses || !data) {
    throw new Error('[migration-reverse] a down migration must declare "-- Reverses <tag>." and "-- data: SCHEMA_ONLY|DROPS_DATA"');
  }
  return { reverses, data, affects: affects ? affects.split(',').map((s) => s.trim()).filter(Boolean) : [] };
}

export function downPathFor(tag: string, dir = 'drizzle'): string {
  return join(dir, 'down', `${tag}.down.sql`);
}

export function hasDown(tag: string, dir = 'drizzle'): boolean {
  return existsSync(downPathFor(tag, dir));
}

export function readDown(tag: string, dir = 'drizzle'): string {
  return readFileSync(downPathFor(tag, dir), 'utf8');
}
