import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INVARIANTS (addendum §4, §18 / P0.0).
 *
 * The rules file is not code this repository executes, so nothing else in the test suite would
 * ever notice it changing. It is also the single highest-consequence file in the project: while
 * it reads `allow read, write: if true`, anyone holding the committed public API key can rewrite
 * the knowledge and company-brain documents that are stringified into every outbound prompt, and
 * can write an `oauth_connections` row carrying a real provider token.
 *
 * These assertions are about the FILE, and that is the limit of what they prove. They do not
 * prove the rules are deployed — nothing in this repository can, and the status document says so.
 */

const RULES = readFileSync('firestore.rules', 'utf8');

/** Rule text with comments removed, so a documented example is not read as an active rule. */
const ACTIVE = RULES.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('§4 — the datastore is not world-writable', () => {
  it('contains no unconditional allow', () => {
    // The exact rule this file shipped with for the life of the project.
    expect(ACTIVE).not.toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+true/);
    expect(ACTIVE).not.toMatch(/allow\s+\w+(\s*,\s*\w+)*\s*:\s*if\s+true\s*;/);
  });

  it('denies by default, so a collection added later is closed', () => {
    // The previous rule made every new collection public the moment it was created.
    expect(ACTIVE).toMatch(/match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read\s*,\s*write\s*:\s*if\s+false\s*;\s*\}/);
  });

  it('has no allow rule that is not explicitly false', () => {
    // Any `allow ... : if <anything other than false>` in the ACTIVE text is a grant, and there
    // is currently no client that should have one.
    const grants = [...ACTIVE.matchAll(/allow\s+[^:]+:\s*if\s+([^;]+);/g)].map((m) => m[1].trim());
    expect(grants.every((g) => g === 'false'), `found grants: ${JSON.stringify(grants)}`).toBe(true);
  });

  it('still declares a rules version', () => {
    expect(ACTIVE).toMatch(/rules_version\s*=\s*'2'/);
  });
});

describe('the rules are deployable now, and the file says what still needs a console', () => {
  it('no longer tells the reader not to deploy', () => {
    // This assertion is the inverse of the one it replaces, and the replaced one predicted it:
    // "This test failing is a prompt to re-read that file, not a defect."
    //
    // Matched against the text with the historical paragraph removed, because that paragraph
    // quotes the old warning in order to explain why it lifted. A check that reads the
    // explanation as the defect teaches people to delete the explanation.
    const withoutHistory = RULES.replace(/This block used to read[\s\S]*?open\./, '');
    expect(withoutHistory).not.toMatch(/DO NOT DEPLOY/i);
  });

  it('names the three steps that are still a console action', () => {
    // Deploying the rules, rotating the published credentials and auditing what was written
    // while the door was open are three different jobs. Doing the first does not do the others,
    // and the file is where somebody reaching for `firebase deploy` will look.
    expect(RULES).toMatch(/firebase deploy --only firestore:rules/);
    expect(RULES).toMatch(/[Rr]otate/);
    expect(RULES).toMatch(/apiKey/);
    expect(RULES).toMatch(/[Aa]udit the live Firestore/);
  });

  it('says a rules file in a repository is not a deployed rule', () => {
    // The single most likely misreading of this change is that closing the file closed the
    // database. It did not. Until step 1 runs, the live instance is exactly as open as it was.
    expect(RULES).toMatch(/still world-readable and world-writable/);
  });
});

describe('what makes deny-all safe: nothing reads Firestore any more', () => {
  /**
   * The reason the deploy warning lifted is not that credentials arrived. It is that the
   * dependency went away: the document collections moved to PostgreSQL, so there is no reader
   * left for deny-all to deny.
   *
   * That is a property of the whole server, not of one file, so it is checked across the whole
   * server. If any module starts talking to Firestore again, deploying these rules would stop
   * the application — and this test failing is the warning that the file's header has gone
   * stale again.
   */
  const sources = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'node_modules') continue;
        out.push(...sources(full));
      } else if (entry.name.endsWith('.ts')) {
        out.push(full);
      }
    }
    return out;
  };

  it('scanned a meaningful number of server files', () => {
    // A floor, so a broken walk cannot report "no offenders" from an empty list.
    expect(sources('server').length).toBeGreaterThan(40);
  });

  it('no server module imports firebase/firestore', () => {
    const offenders = [...sources('server'), 'server.ts'].filter((f) =>
      readFileSync(f, 'utf8').includes('firebase/firestore')
    );
    expect(offenders, `still on the Firestore SDK: ${offenders.join(', ')}`).toEqual([]);
  });

  it('server/firebase.ts initialises authentication and nothing else', () => {
    const firebase = readFileSync('server/firebase.ts', 'utf8');
    const active = firebase
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(active).not.toContain('firebase/firestore');
    expect(active).not.toContain('getFirestore');
    expect(active).not.toContain('signInAnonymously');
    expect(active).toContain('firebase-admin/auth');
  });

  it('the browser bundle still never imports firestore either', () => {
    // True before this change and still true. Stated because the rules header rests on it:
    // if a client ever did read Firestore directly, deny-all would break the product.
    const client = readFileSync('src/lib/firebase.ts', 'utf8');
    expect(client).not.toContain('firebase/firestore');
  });
});
