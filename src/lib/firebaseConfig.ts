/**
 * THE FIREBASE AUTH CONFIG, FROM THE ENVIRONMENT INSTEAD OF FROM A COMMITTED FILE.
 *
 * WHAT WAS WRONG
 * --------------
 * `src/lib/firebase.ts` did `import firebaseConfig from '../../firebase-applet-config.json'`.
 * That file is TRACKED IN GIT and carries the `apiKey`, the `oAuthClientId`, the
 * `messagingSenderId` and the rest. Vite inlines an imported JSON module, so every one of those
 * values was compiled into the browser bundle whether or not anything read it.
 *
 * The roadmap has said "rotate the committed apiKey and OAuth client" since the first audit, and
 * it stayed undone partly because doing it meant editing a tracked file and rebuilding —
 * rotation as a code change rather than a configuration change. Anything that makes rotation a
 * commit will be done late, or not at all.
 *
 * Reading the four values Auth actually needs from `import.meta.env` makes rotation an
 * environment edit, and lets the committed file stop existing.
 *
 * IS THIS A SECRET? NOT EXACTLY, AND THAT IS NOT THE POINT.
 * --------------------------------------------------------
 * A Firebase web `apiKey` is designed to be public — it identifies a project, it does not
 * authorise anything, and security rules are what protect the data. This is not a claim that it
 * was a leaked password.
 *
 * It still matters here for two reasons the general case does not cover. The datastore rules
 * were `allow read, write: if true` for the life of the project, so during that window the
 * public key WAS sufficient to read and write every document. And the same file carries the
 * OAuth client id, which is what an attacker needs to build a convincing consent screen against
 * this project. Rotating both is still the right call, and this is what makes it cheap.
 *
 * FOUR FIELDS, NOT TEN
 * --------------------
 * Only what `firebase/auth` needs. The file also holds `firestoreDatabaseId`, `storageBucket`,
 * `measurementId`, `recaptchaSiteKey` and `messagingSenderId`, and nothing reads any of them:
 * the document collections moved to PostgreSQL and there is no client SDK for them any more.
 * What a page ships is what an attacker gets to read, so it ships what it uses.
 */

export interface FirebaseAuthConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
}

export type ConfigResolution =
  | { readonly ok: true; readonly config: FirebaseAuthConfig }
  | { readonly ok: false; readonly missing: string[]; readonly message: string };

export const REQUIRED_VARS = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

/**
 * Resolve the config from an environment object.
 *
 * Takes the environment as a parameter rather than reading `import.meta.env` directly, so every
 * branch — including the one where a variable is present but empty — can be exercised by a test
 * without a build.
 *
 * AN EMPTY STRING IS MISSING, NOT PRESENT. `VITE_FIREBASE_API_KEY=` in a `.env` file produces
 * `''`, and passing that to `initializeApp` yields an opaque failure at the first sign-in
 * rather than at startup. A value nobody set is not a value.
 */
export function resolveFirebaseAuthConfig(env: Record<string, unknown>): ConfigResolution {
  const read = (name: string): string | null => {
    const value = env[name];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  };

  const missing = REQUIRED_VARS.filter((name) => read(name) === null);
  if (missing.length > 0) {
    return {
      ok: false,
      missing: [...missing],
      message:
        `Firebase Auth is not configured: ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } missing or empty. ` +
        'Set them in .env; Vite reads them at build time, so a running deployment needs a ' +
        'rebuild after a change. See .env.example.',
    };
  }

  return {
    ok: true,
    config: {
      apiKey: read('VITE_FIREBASE_API_KEY')!,
      authDomain: read('VITE_FIREBASE_AUTH_DOMAIN')!,
      projectId: read('VITE_FIREBASE_PROJECT_ID')!,
      appId: read('VITE_FIREBASE_APP_ID')!,
    },
  };
}

/**
 * The resolved config, or a thrown error naming exactly what is missing.
 *
 * Throwing at module load rather than returning a partial config is deliberate: a browser app
 * that starts without a usable auth configuration reaches the sign-in button and fails there,
 * which reads to a user as "login is broken" rather than "this deployment was not configured".
 */
export function firebaseAuthConfig(env: Record<string, unknown>): FirebaseAuthConfig {
  const resolution = resolveFirebaseAuthConfig(env);
  if (resolution.ok === false) throw new Error(resolution.message);
  return resolution.config;
}
