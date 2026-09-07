import { initializeApp as initializeAdminApp, getApps } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

/**
 * FIREBASE IS NOW AUTHENTICATION, AND NOTHING ELSE.
 *
 * WHAT THIS FILE USED TO DO
 * -------------------------
 * It opened Firestore with the CLIENT SDK, from the server, unauthenticated. Its own comment
 * said why:
 *
 *     // 1. Client SDK for Firestore (to bypass IAM limits via anonymous auth)
 *     // Anonymous auth removed since firestore rules are relaxed for the preview environment
 *
 * Those two lines are the whole exposure in miniature. Security rules apply to the client SDK
 * and not to the Admin SDK, so as long as the server reached the datastore this way,
 * `firestore.rules` could never be tightened without denying the server itself. That is why
 * `allow read, write: if true` was still live with the API key committed to a public
 * repository: the workaround and the exposure were the same fact.
 *
 * It also meant the system had two datastores — the producer writing PostgreSQL, the consumer
 * reading Firestore — so every suppression check and campaign guard in this repository
 * enforced against a store the send path did not write. `server/store/index.ts` has the full
 * account.
 *
 * Both are gone. The document collections now live in PostgreSQL beside the relational tables,
 * and nothing in this repository reads or writes Firestore.
 *
 * WHAT REMAINS, AND WHY IT IS WORTH KEEPING
 * -----------------------------------------
 * Verifying a Google sign-in. The browser signs in with Firebase Auth and sends an ID token;
 * this verifies the signature, the issuer and the audience before `server/middleware/auth.ts`
 * will mint a session. Replacing that means owning token issuance, refresh and revocation, and
 * there is no reason to.
 *
 * IT NEEDS NO SERVICE ACCOUNT — measured, not assumed. `verifyIdToken` checks a JWT against
 * Google's public signing certificates and the project id; it does not call a privileged API.
 * Initialised with `projectId` alone it reaches token decoding and rejects a malformed token
 * on its merits, which is the behaviour that matters. (`checkRevoked: true` WOULD need
 * credentials, because it queries the Auth backend. It is not used, and adding it means adding
 * a service account at the same time.)
 *
 * FAILING TO INITIALISE IS LOUD, AND IT IS NOT PERMISSION
 * ------------------------------------------------------
 * A null export here means no request can be authenticated. `requireAuth` treats that as a
 * refusal rather than a waiver — it used to accept every token when this failed, which is how
 * a misconfigured deployment degraded silently from "verifies tokens" to "accepts anything"
 * with a single console line as the only signal. The line below is `console.error` for the
 * same reason: this is not an informational message.
 */

/**
 * The project id, from the environment. There is no longer a file to fall back to.
 *
 * This used to read `firebase-applet-config.json` when the environment was unset. That file was
 * TRACKED IN GIT and carried the apiKey and the OAuth client id alongside the project id, and
 * the fallback is part of why it stayed tracked: something still depended on it. It is deleted
 * now, and the four values the browser needs come from `.env` (see `src/lib/firebaseConfig.ts`).
 *
 * A MISSING PROJECT ID REFUSES EVERY REQUEST, LOUDLY. `requireAuth` treats a null export as a
 * refusal rather than a waiver — it used to accept every token when this failed, which is how a
 * misconfigured deployment degraded silently from "verifies tokens" to "accepts anything".
 * Erroring here with the variable named is the difference between a deployment that will not
 * authenticate anybody and one nobody notices is open.
 */
function resolveProjectId(): string | null {
  const fromEnv = process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv.trim() : null;
}

function initialiseAuth(): any {
  const projectId = resolveProjectId();
  if (!projectId) {
    console.error(
      '[firebase] No project id. Set FIREBASE_PROJECT_ID in the environment. Token verification ' +
        'is UNAVAILABLE, so every authenticated request will be refused.'
    );
    return null;
  }

  try {
    // Reuse the app across hot reloads and test imports; initializeApp throws on a duplicate
    // name, and that throw would land in the catch below and read as a configuration failure.
    const existing = getApps().find((app) => app.name === 'auth');
    const app = existing ?? initializeAdminApp({ projectId }, 'auth');
    return getAdminAuth(app);
  } catch (e: any) {
    console.error(
      '[firebase] Auth initialisation failed; every authenticated request will be refused:',
      e?.message ?? e
    );
    return null;
  }
}

export const firebaseAuth = initialiseAuth();
