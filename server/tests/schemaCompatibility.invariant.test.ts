import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compareMigrations,
  schemaPermitsIrreversibleActions,
  expectedMigrationCount,
  migrationCountFrom,
  SCHEMA_STATES,
  type SchemaState,
} from '../build/schemaCompatibility';
import { healthResponse } from '../build/health';

/**
 * INVARIANTS FOR THE SCHEMA COMPATIBILITY CHECK (addendum §48, §14).
 *
 * S48's own remainder: *nothing yet refuses to serve when the schema is behind the build.*
 * `/api/health` printed `expectsMigration` and then answered `status: "ok"` regardless — a
 * verdict that ignores the evidence beside it, which is worse than printing neither, because it
 * looks like the check was made.
 */

describe('1. the four states, and which of them permits an irreversible action', () => {
  it('equal counts match', () => {
    const result = compareMigrations(7, 7);
    expect(result.state).toBe('MATCHED');
    expect(schemaPermitsIrreversibleActions(result)).toBe(true);
  });

  it('fewer applied than expected is BEHIND — the rolling-deploy case', () => {
    const result = compareMigrations(7, 6);
    expect(result.state).toBe('DATABASE_BEHIND');
    expect(schemaPermitsIrreversibleActions(result)).toBe(false);
  });

  it('more applied than expected is AHEAD — the rollback case', () => {
    // The quieter and worse of the two: this build cannot see columns it does not know about,
    // so a write silently drops fields rather than failing.
    const result = compareMigrations(6, 7);
    expect(result.state).toBe('DATABASE_AHEAD');
    expect(schemaPermitsIrreversibleActions(result)).toBe(false);
  });

  it('§14 — a count that could not be read is UNKNOWN, and UNKNOWN refuses', () => {
    for (const [expected, applied] of [
      [null, 7],
      [7, null],
      [null, null],
    ] as [number | null, number | null][]) {
      const result = compareMigrations(expected, applied);
      expect(result.state, `${expected}/${applied}`).toBe('UNKNOWN');
      expect(schemaPermitsIrreversibleActions(result)).toBe(false);
    }
  });

  it('a state nobody anticipated also refuses', () => {
    // `=== 'MATCHED'`, not `!== 'DATABASE_BEHIND'`. A fifth state added without thought must
    // fail closed; the dispatch gate's `default: return true` is how the opposite went wrong
    // in this codebase already.
    const invented = { state: 'PROBABLY_FINE' as SchemaState, expected: 1, applied: 1, detail: '' };
    expect(schemaPermitsIrreversibleActions(invented)).toBe(false);
  });

  it('zero applied is BEHIND, not UNKNOWN — an empty database is an answer', () => {
    expect(compareMigrations(7, 0).state).toBe('DATABASE_BEHIND');
  });

  it('a fresh project with no migrations at all still matches', () => {
    expect(compareMigrations(0, 0).state).toBe('MATCHED');
  });
});

describe('2. the detail is something an operator can act on', () => {
  it('BEHIND names the command that fixes it', () => {
    expect(compareMigrations(7, 5).detail).toContain('npm run migrate');
  });

  it('every state carries both counts, so the message is checkable', () => {
    const behind = compareMigrations(7, 5);
    expect(behind.expected).toBe(7);
    expect(behind.applied).toBe(5);
    expect(behind.detail).toContain('5');
    expect(behind.detail).toContain('7');
  });

  it('AHEAD says why a silent field drop is the risk, not a crash', () => {
    expect(compareMigrations(5, 7).detail).toMatch(/silently drop/i);
  });

  it('UNKNOWN says it is refusing rather than assuming', () => {
    expect(compareMigrations(null, null).detail).toMatch(/refusing/i);
  });

  it('every declared state is reachable from compareMigrations', () => {
    // Guards against a state being declared, never produced, and quietly permitted somewhere.
    const produced = new Set<string>([
      compareMigrations(1, 1).state,
      compareMigrations(2, 1).state,
      compareMigrations(1, 2).state,
      compareMigrations(null, 1).state,
    ]);
    expect([...produced].sort()).toEqual([...SCHEMA_STATES].sort());
  });
});

describe('3. the count comes from the real journal', () => {
  it('agrees with the checked-in journal', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'));
    expect(expectedMigrationCount()).toBe(journal.entries.length);
    expect(expectedMigrationCount()).toBeGreaterThan(0);
  });

  it('a missing journal is null, not zero', () => {
    // Zero would compare as "this build expects no migrations", and an empty database would
    // then MATCH it — a broken read resolving to permission, which is the §14 inversion.
    expect(expectedMigrationCount('does/not/exist')).toBeNull();
  });

  it('a journal that parses but has no entries array is null, not zero', () => {
    // A mutant returning 0 here survived: a missing FILE throws and is caught, but a file whose
    // shape is wrong takes a different path, and nothing exercised it.
    for (const content of ['{}', '{"entries": null}', '{"entries": 3}', '[]', 'null']) {
      const dir = mkdtempSync(join(tmpdir(), 'journal-'));
      mkdirSync(join(dir, 'meta'), { recursive: true });
      writeFileSync(join(dir, 'meta/_journal.json'), content);
      expect(expectedMigrationCount(dir), `accepted ${content}`).toBeNull();
    }
  });

  it('a journal that is not valid JSON is null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-'));
    mkdirSync(join(dir, 'meta'), { recursive: true });
    writeFileSync(join(dir, 'meta/_journal.json'), 'not json at all');
    expect(expectedMigrationCount(dir)).toBeNull();
  });
});

describe('3b. the applied count is read, not assumed', () => {
  it('a well-formed row yields its number', () => {
    expect(migrationCountFrom([{ n: 7 }])).toBe(7);
    expect(migrationCountFrom([{ n: 0 }])).toBe(0);
  });

  it('anything else is null, not zero', () => {
    // A mutant returning 0 for an unreadable row survived. Zero is a real, meaningful count —
    // an unmigrated database — so using it to mean "could not read" makes the two
    // indistinguishable, and one of them must refuse while the other need not.
    for (const rows of [
      [],
      null,
      undefined,
      'seven',
      [null],
      [{}],
      [{ n: '7' }],
      [{ n: 1.5 }],
      [{ n: -1 }],
      [{ n: null }],
    ] as unknown[]) {
      expect(migrationCountFrom(rows), `accepted ${JSON.stringify(rows)}`).toBeNull();
    }
  });
});

describe('3c. the health answer is a function of the schema state', () => {
  const build = { sha: 'abc', source: 'INJECTED', identifiesAReleasedArtifact: true } as never;

  it('MATCHED is 200 and ok', () => {
    const answer = healthResponse(build, compareMigrations(7, 7));
    expect(answer.status).toBe(200);
    expect(answer.body.status).toBe('ok');
  });

  it('every other state is 503 and degraded', () => {
    // The status CODE has to move, not just the word: `status: "degraded"` inside a 200 is
    // invisible to every load balancer and uptime check that reads the code and not the body.
    for (const schema of [
      compareMigrations(7, 6),
      compareMigrations(6, 7),
      compareMigrations(null, 7),
    ]) {
      expect(answer503(schema), schema.state).toBe(true);
    }
    function answer503(schema: ReturnType<typeof compareMigrations>): boolean {
      const answer = healthResponse(build, schema);
      return answer.status === 503 && answer.body.status === 'degraded';
    }
  });

  it('a state nobody anticipated is degraded, not ok', () => {
    const invented = { state: 'PROBABLY_FINE' as SchemaState, expected: 1, applied: 1, detail: '' };
    expect(healthResponse(build, invented).status).toBe(503);
  });

  it('reports the schema it judged on, so the verdict can be checked', () => {
    const schema = compareMigrations(7, 6);
    expect(healthResponse(build, schema).body.schema).toEqual(schema);
  });
});

describe('4. it is wired where it matters, and only where it matters', () => {
  const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
  const serverEntry = readFileSync('server/routes/health.routes.ts', 'utf8');

  it('the gateway consults it before dispatching an irreversible action', () => {
    expect(gateway).toContain('schemaPermitsIrreversibleActions(');
    expect(gateway).toContain('isIrreversible(request.actionType)');
  });

  it('the check happens before the feature flag, so nothing runs on a wrong schema', () => {
    const schema = gateway.indexOf('schemaPermitsIrreversibleActions(');
    const flag = gateway.indexOf('if (!this.checkFeatureFlag(request.actionType))');
    expect(schema).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(-1);
    expect(schema).toBeLessThan(flag);
  });

  it('health answers through healthResponse rather than deciding inline', () => {
    // Asserted as a call, not as an inline expression: while the decision was inline, a mutant
    // replacing it with `const healthy = true` passed, because the source assertion checked for
    // the shape of the branch and not for the value it branched on.
    expect(serverEntry).toContain('healthResponse(resolveProvenance()');
    expect(serverEntry).toContain('await schemaCompatibility()');
    expect(serverEntry).toContain('res.status(answer.status).json(answer.body)');
  });
});
