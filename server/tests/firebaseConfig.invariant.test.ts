import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  resolveFirebaseAuthConfig,
  firebaseAuthConfig,
  REQUIRED_VARS,
} from '../../src/lib/firebaseConfig';

/**
 * INVARIANTS FOR THE FIREBASE AUTH CONFIG (addendum P0.0).
 *
 * `src/lib/firebase.ts` did `import firebaseConfig from '../../firebase-applet-config.json'` —
 * a TRACKED file carrying the apiKey and the OAuth client id. Vite inlines an imported JSON
 * module, so every value in it was compiled into the browser bundle whether or not anything
 * read it, and rotating any of them meant editing a tracked file and rebuilding.
 *
 * "Rotate the committed credentials" has been on this roadmap since the first audit. Part of
 * why it stayed undone is that it was a code change. It is a configuration change now.
 */

describe('1. the config comes from the environment, and says what is missing', () => {
  const complete = {
    VITE_FIREBASE_API_KEY: 'key',
    VITE_FIREBASE_AUTH_DOMAIN: 'domain',
    VITE_FIREBASE_PROJECT_ID: 'project',
    VITE_FIREBASE_APP_ID: 'app',
  };

  it('resolves when every variable is set', () => {
    const result = resolveFirebaseAuthConfig(complete);
    expect(result.ok).toBe(true);
    expect(result.ok && result.config).toEqual({
      apiKey: 'key',
      authDomain: 'domain',
      projectId: 'project',
      appId: 'app',
    });
  });

  it('names every missing variable, not just the first', () => {
    // A message naming one variable produces four rebuilds. The failure is at deploy time and
    // the person reading it cannot see the code.
    const result = resolveFirebaseAuthConfig({ VITE_FIREBASE_API_KEY: 'key' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.missing).toHaveLength(3);
      for (const name of result.missing) expect(result.message).toContain(name);
    }
  });

  it('each variable is individually required', () => {
    for (const name of REQUIRED_VARS) {
      const partial: Record<string, unknown> = { ...complete };
      delete partial[name];
      const result = resolveFirebaseAuthConfig(partial);
      expect(result.ok, `${name} was not required`).toBe(false);
      expect(result.ok === false && result.missing).toContain(name);
    }
  });

  it('an empty or blank value is MISSING, not present', () => {
    // `VITE_FIREBASE_API_KEY=` in a .env file produces `''`. Passing that to initializeApp
    // fails opaquely at the first sign-in rather than at startup; a value nobody set is not a
    // value.
    for (const bad of ['', '   ', '\t']) {
      const result = resolveFirebaseAuthConfig({ ...complete, VITE_FIREBASE_API_KEY: bad });
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('a non-string value is missing rather than coerced', () => {
    for (const bad of [null, undefined, 42, {}, ['key']]) {
      const result = resolveFirebaseAuthConfig({ ...complete, VITE_FIREBASE_APP_ID: bad });
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('surrounding whitespace is trimmed, not stored', () => {
    const result = resolveFirebaseAuthConfig({ ...complete, VITE_FIREBASE_API_KEY: '  key  ' });
    expect(result.ok && result.config.apiKey).toBe('key');
  });

  it('firebaseAuthConfig throws with the message rather than returning a partial config', () => {
    // A browser app that starts with a half-configured auth reaches the sign-in button and
    // fails there, which reads as "login is broken" rather than "this was not configured".
    expect(() => firebaseAuthConfig({})).toThrow(/VITE_FIREBASE_API_KEY/);
    expect(() => firebaseAuthConfig(complete)).not.toThrow();
  });
});

describe('2. the tracked credential file is gone, and nothing depends on it', () => {
  it('the file is not in the working tree', () => {
    expect(
      existsSync('firebase-applet-config.json'),
      'firebase-applet-config.json is back — it carries the apiKey and the OAuth client id'
    ).toBe(false);
  });

  /**
   * A READ, not a mention.
   *
   * The first version of this assertion looked for the string anywhere outside a comment, and
   * failed on `firebaseConfig.ts` — which names the file in its RUNTIME ERROR MESSAGE, to tell
   * whoever hits it where those values used to come from. That is the opposite of the defect:
   * it is the fix explaining itself. So this matches the three ways a file is actually read.
   */
  const READS = [
    /import[^\n]*from\s*['"][^'"]*firebase-applet-config[^'"]*['"]/,
    /require\s*\(\s*['"][^'"]*firebase-applet-config/,
    // `[\s\S]{0,200}?` and not `[^)]*`: the first version stopped at the first closing paren,
    // so `readFileSync(resolve(cwd(), 'firebase-applet-config.json'))` — the exact shape the
    // deleted code in `set-org-claim.mjs` used — went undetected. The self-check below is what
    // found that, which is what a self-check is for.
    /readFileSync\s*\([\s\S]{0,200}?firebase-applet-config/,
  ];

  /**
   * Comments go first, and then the read patterns.
   *
   * Both are needed, and finding that out took two failures. Stripping comments alone still
   * flagged the RUNTIME ERROR MESSAGE in `firebaseConfig.ts`, which names the file to tell
   * whoever hits it where the values used to come from. Read patterns alone still flagged the
   * header of that same file, which QUOTES the import it replaced —
   * `import firebaseConfig from '../../firebase-applet-config.json'` — verbatim.
   *
   * Each check on its own reads the fix's own explanation as the defect, which is the thing
   * that teaches people to delete the explanation.
   */
  const withoutComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('no source file imports or reads it', () => {
    for (const file of [
      'src/lib/firebase.ts',
      'src/lib/firebaseConfig.ts',
      'server/firebase.ts',
      'scripts/set-org-claim.mjs',
    ]) {
      const code = withoutComments(readFileSync(file, 'utf8'));
      for (const pattern of READS) {
        expect(code, `${file} still reads the config file`).not.toMatch(pattern);
      }
    }
  });

  it('that check would catch a real read', () => {
    // The other half: a pattern set matching nothing satisfies the assertion above on any
    // codebase at all.
    for (const sample of [
      "import firebaseConfig from '../../firebase-applet-config.json';",
      "const c = require('./firebase-applet-config.json');",
      "readFileSync(resolve(cwd(), 'firebase-applet-config.json'), 'utf8')",
    ]) {
      expect(
        READS.some((p) => p.test(sample)),
        `not detected: ${sample}`
      ).toBe(true);
    }
    // And a mention in prose is not a read.
    expect(READS.some((p) => p.test('// used to come from firebase-applet-config.json'))).toBe(
      false
    );
  });

  it('.env.example documents the variables that replaced it, with no values', () => {
    // The example file is tracked. A real value in it would put the credentials straight back
    // into git, which is the thing being undone.
    const example = readFileSync('.env.example', 'utf8');
    for (const name of REQUIRED_VARS) {
      expect(example, `${name} is not documented`).toContain(name);
      expect(example, `${name} has a value in .env.example`).toMatch(
        new RegExp('^' + name + '=\\s*$', 'm')
      );
    }
    expect(example).toContain('FIREBASE_PROJECT_ID=');
  });

  it('.env.example carries no assignment with a value at all', () => {
    // Every line is either a comment, blank, `NAME=`, or one of the few safe defaults that are
    // deliberately literal. Anything else is a secret somebody pasted in.
    const SAFE = new Set(['false', 'development', '3000']);
    const offenders: string[] = [];
    for (const line of readFileSync('.env.example', 'utf8').split(/\r?\n/)) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = match[2].trim();
      if (value.length > 0 && !SAFE.has(value)) offenders.push(line.trim());
    }
    expect(offenders, `values in .env.example: ${offenders.join(', ')}`).toEqual([]);
  });
});
