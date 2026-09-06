import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

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

describe('P0.0 — the file records why it cannot be deployed yet', () => {
  it('warns that the server is still an unauthenticated client-SDK caller', () => {
    // Deploying these rules before the server moves to firebase-admin would deny the server and
    // stop the application. That is the whole reason this has not shipped, and a reader opening
    // this file needs it before they reach for `firebase deploy`.
    expect(RULES).toMatch(/DO NOT DEPLOY/i);
    expect(RULES).toMatch(/firebase-admin/);
    expect(RULES).toMatch(/signInAnonymously/);
  });

  it('names credential rotation as a separate step', () => {
    // Closing the rules does not un-publish a key that has been public.
    expect(RULES).toMatch(/[Rr]otate/);
    expect(RULES).toMatch(/apiKey/);
  });
});

describe('P0.0 — the server is still on the client SDK, which is why the above holds', () => {
  it('imports signInAnonymously and does not call it', () => {
    // If this ever stops being true, the deploy warning in firestore.rules is stale and the
    // rules may be deployable. This test failing is a prompt to re-read that file, not a defect.
    const firebase = readFileSync('server/firebase.ts', 'utf8');
    const active = firebase.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(active).toContain('signInAnonymously');
    expect(active).not.toMatch(/signInAnonymously\s*\(/);
    expect(active).toContain('firebase/firestore');
  });
});
