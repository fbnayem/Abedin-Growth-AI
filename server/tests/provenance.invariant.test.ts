import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveProvenance, describeProvenance } from '../build/provenance';

/**
 * S49 — WHICH BUILD IS THIS?
 *
 * `/api/health` answered `{ status: "ok", service: "Abedin Growth AI Core Engine" }`. That
 * string is identical in every build that has ever run, so the endpoint answers the question
 * "is something listening" and no other.
 *
 * S49's worst case turns on the difference. An operator watches the agent send something it
 * should not and reaches for the kill switch; nobody can say which build is live, so nobody can
 * say what to roll back to. `package.json` says `"version": "0.0.0"`, there are no tags, and no
 * commit id is embedded anywhere.
 *
 * The tests below are mostly about what this module REFUSES to report. A SHA that is wrong is
 * worse than one that is missing: the missing one sends someone to look, and the wrong one ends
 * the search. This repository has already shipped a readiness script that created the document
 * it was checking for and then reported it as present — the same move, one level down, and the
 * reason the fallbacks here are labelled rather than silent.
 */

/** A throwaway directory with the git bits this module reads, and nothing else. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const SHA = 'a'.repeat(40);
const JOURNAL = JSON.stringify({
  entries: [
    { idx: 1, tag: '0001_second' },
    { idx: 0, tag: '0000_first' },
    { idx: 2, tag: '0002_third' },
  ],
});

// ===========================================================================
describe('1. an unknown build says so', () => {
  /**
   * The invariant. Every alternative — a placeholder SHA, "0.0.0", the string "unknown" in a
   * field typed as a SHA — is a value that looks like an answer.
   */
  it('reports UNKNOWN rather than inventing an identity', () => {
    const p = resolveProvenance({} as NodeJS.ProcessEnv, fixture({}));
    expect(p.source).toBe('UNKNOWN');
    expect(p.sha).toBeNull();
    expect(p.identifiesAReleasedArtifact).toBe(false);
  });

  it('a missing version is null, not a version-looking string', () => {
    const p = resolveProvenance({} as NodeJS.ProcessEnv, fixture({}));
    expect(p.version).toBeNull();
    expect(p.builtAt).toBeNull();
  });

  it('an empty BUILD_SHA is treated as absent, not as an identity', () => {
    for (const value of ['', '   ']) {
      const p = resolveProvenance({ BUILD_SHA: value } as NodeJS.ProcessEnv, fixture({}));
      expect(p.source).toBe('UNKNOWN');
    }
  });
});

// ===========================================================================
describe('2. injected and inferred are not the same claim', () => {
  it('an injected SHA identifies a released artifact', () => {
    const p = resolveProvenance(
      { BUILD_SHA: SHA, BUILD_VERSION: 'v1.4.0', BUILD_TIME: '2026-09-08T00:00:00Z' } as NodeJS.ProcessEnv,
      fixture({})
    );
    expect(p.source).toBe('INJECTED');
    expect(p.sha).toBe(SHA);
    expect(p.version).toBe('v1.4.0');
    expect(p.identifiesAReleasedArtifact).toBe(true);
  });

  /**
   * The one that matters. A working tree can carry uncommitted changes, so the SHA names a
   * commit that is not necessarily what is running. Reporting it is useful; reporting it as a
   * released artifact would be a wrong answer that ends the search.
   */
  it('a SHA read from a working tree does NOT identify a released artifact', () => {
    const dir = fixture({ '.git/HEAD': SHA + '\n' });
    const p = resolveProvenance({} as NodeJS.ProcessEnv, dir);
    expect(p.source).toBe('GIT_WORKING_TREE');
    expect(p.sha).toBe(SHA);
    expect(p.identifiesAReleasedArtifact).toBe(false);
  });

  it('an injection wins over a working tree, because it describes the artifact', () => {
    const dir = fixture({ '.git/HEAD': 'b'.repeat(40) + '\n' });
    const p = resolveProvenance({ BUILD_SHA: SHA } as NodeJS.ProcessEnv, dir);
    expect(p.source).toBe('INJECTED');
    expect(p.sha).toBe(SHA);
  });

  it('the description always names the source beside the SHA', () => {
    const injected = describeProvenance(
      resolveProvenance({ BUILD_SHA: SHA } as NodeJS.ProcessEnv, fixture({}))
    );
    const tree = describeProvenance(
      resolveProvenance({} as NodeJS.ProcessEnv, fixture({ '.git/HEAD': SHA + '\n' }))
    );
    expect(injected).toContain('INJECTED');
    expect(tree).toContain('GIT_WORKING_TREE');
    expect(injected).not.toBe(tree);
  });
});

// ===========================================================================
describe('3. reading git without shelling out', () => {
  it('follows a symbolic HEAD to a loose ref', () => {
    const dir = fixture({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/refs/heads/main': SHA + '\n',
    });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).sha).toBe(SHA);
  });

  /** A branch whose ref has been packed has no file at `.git/refs/heads/<name>`. */
  it('follows a symbolic HEAD into packed-refs', () => {
    const dir = fixture({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`,
    });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).sha).toBe(SHA);
  });

  it('a ref that resolves to nothing is UNKNOWN, not a partial answer', () => {
    const dir = fixture({ '.git/HEAD': 'ref: refs/heads/gone\n' });
    const p = resolveProvenance({} as NodeJS.ProcessEnv, dir);
    expect(p.source).toBe('UNKNOWN');
    expect(p.sha).toBeNull();
  });

  it('a HEAD containing something that is not a SHA is UNKNOWN', () => {
    const dir = fixture({ '.git/HEAD': 'not a sha at all\n' });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).source).toBe('UNKNOWN');
  });

  it('an unreadable git directory degrades to UNKNOWN rather than throwing', () => {
    const dir = fixture({ '.git/HEAD': 'ref: refs/heads/main\n' });
    rmSync(join(dir, '.git/HEAD'));
    expect(() => resolveProvenance({} as NodeJS.ProcessEnv, dir)).not.toThrow();
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).source).toBe('UNKNOWN');
  });
});

// ===========================================================================
describe('4. the build says which schema it expects', () => {
  /**
   * "The code is ahead of the schema" and "the schema is ahead of the code" are different
   * incidents with different rollbacks, and during a rolling deploy both are live at once. A
   * build that cannot state its expectation makes them the same event.
   */
  it('reports the last migration in the journal it ships with', () => {
    const dir = fixture({ 'drizzle/meta/_journal.json': JOURNAL });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).expectsMigration).toBe('0002_third');
  });

  /**
   * Ordered by `idx`, not by position in the array. Written so the two disagree: the LAST
   * element here is 0001_second, so a reader that took `entries.at(-1)` — which is right for
   * the real journal and for the fixture above — gets the wrong answer and this fails.
   */
  it('orders by idx, not by the order the entries happen to appear', () => {
    const outOfOrder = JSON.stringify({
      entries: [
        { idx: 2, tag: '0002_third' },
        { idx: 0, tag: '0000_first' },
        { idx: 1, tag: '0001_second' },
      ],
    });
    const dir = fixture({ 'drizzle/meta/_journal.json': outOfOrder });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, dir).expectsMigration).toBe('0002_third');
  });

  it('a missing or unreadable journal is null, not a guess', () => {
    expect(resolveProvenance({} as NodeJS.ProcessEnv, fixture({})).expectsMigration).toBeNull();
    const broken = fixture({ 'drizzle/meta/_journal.json': 'not json' });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, broken).expectsMigration).toBeNull();
    const empty = fixture({ 'drizzle/meta/_journal.json': '{"entries":[]}' });
    expect(resolveProvenance({} as NodeJS.ProcessEnv, empty).expectsMigration).toBeNull();
  });

  /** Against the real journal, so the shipped file is the one being described. */
  it('names this repository\'s actual latest migration', () => {
    expect(resolveProvenance(process.env, process.cwd()).expectsMigration).toMatch(/^\d{4}_/);
  });
});
