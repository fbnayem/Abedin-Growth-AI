import { downHeaderOf, downInvertsUp, statementsOf, type DownHeader } from './migration-reverse';

/**
 * S5 — whether one migration may be rolled back, decided as a function.
 *
 * The rollback script used to make these decisions as `if`s between database calls, and a
 * source assertion that the check was CALLED could not tell it from a check whose answer was
 * ignored — a mutation run showed exactly that survivor. Here the decision is a value: the
 * script executes an `ok` plan and prints a refusal, and the suite exercises every refusal
 * with synthetic migrations, no database required.
 *
 * Refusals, in order:
 *   1. no down migration;
 *   2. the down says it reverses a different migration;
 *   3. the down does not invert its up (scripts/lib/migration-reverse.ts);
 *   4. the down drops data and the caller did not allow that.
 */
export type RollbackStepPlan =
  | {
      readonly ok: true;
      readonly tag: string;
      readonly header: DownHeader;
      readonly statements: readonly string[];
      /** Statements of the up with no reverse (backfills, checks): listed, never hidden. */
      readonly dataOnly: readonly string[];
    }
  | { readonly ok: false; readonly tag: string; readonly reason: string };

export function planRollbackStep(input: {
  readonly tag: string;
  readonly up: string;
  readonly down: string | null;
  readonly allowDataLoss: boolean;
}): RollbackStepPlan {
  const { tag, up, down, allowDataLoss } = input;
  if (down === null) {
    return { ok: false, tag, reason: `${tag} has no down migration (drizzle/down/${tag}.down.sql).` };
  }
  let header: DownHeader;
  try {
    header = downHeaderOf(down);
  } catch (e: any) {
    return { ok: false, tag, reason: `${tag}: ${e?.message ?? e}` };
  }
  if (header.reverses !== tag) {
    return { ok: false, tag, reason: `drizzle/down/${tag}.down.sql says it reverses ${header.reverses}, not ${tag}.` };
  }
  const verdict = downInvertsUp(up, down);
  if (!verdict.ok) {
    return {
      ok: false,
      tag,
      reason:
        `the down for ${tag} does not invert its up.\n` +
        `  missing: ${verdict.missing.join(', ') || '-'}\n` +
        `  extra: ${verdict.extra.join(', ') || '-'}`,
    };
  }
  if (header.data === 'DROPS_DATA' && !allowDataLoss) {
    return {
      ok: false,
      tag,
      reason:
        `${tag}'s reverse drops data (${header.affects.join(', ') || 'unspecified'}). ` +
        'Re-run with --allow-data-loss if the row counts printed above are acceptable.',
    };
  }
  return { ok: true, tag, header, statements: statementsOf(down), dataOnly: verdict.dataOnly };
}
