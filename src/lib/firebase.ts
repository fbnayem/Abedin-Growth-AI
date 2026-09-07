import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

/**
 * Only the four fields Firebase Auth needs, rather than the whole config object.
 *
 * The file also carries `firestoreDatabaseId`, `storageBucket`, `messagingSenderId`,
 * `measurementId`, `recaptchaSiteKey` and `oAuthClientId`, and passing the object whole
 * shipped every one of them into the browser bundle — verified by grepping `dist/`, which is
 * the same check that caught the `gmail.send` scope above surviving in the artifact after the
 * source looked clean.
 *
 * Nothing reads any of them now: the document collections moved to PostgreSQL, so there is no
 * Firestore database to name and no client SDK to name it to. What a page ships is what an
 * attacker gets to read, so it ships what it uses.
 */
const app = initializeApp({
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  appId: firebaseConfig.appId,
});
const auth = getAuth(app);

const provider = new GoogleAuthProvider();

// P0.1 — 'gmail.send' and 'calendar.events' were removed from this sign-in.
//
// This was a SECOND path granting the browser a credential able to perform irreversible
// external actions — separate from gmailWorkspaceService, and missed on the first pass. It was
// caught by grepping the built client bundle for the scope string after the other fix landed,
// which is why that check is worth keeping: the source looked clean, the artifact did not.
//
// Neither scope was used. Every Google call in the client is a Gmail label or message READ
// issued with gmailWorkspaceService's own token, and there are no calendar API calls in src/
// at all. So these grants were pure standing privilege: a token that could send mail and write
// calendar events as the user, held in a browser with no HTML sanitizer and no CSP (see S35).
//
// Sending and calendar mutation belong on the server, behind the ActionGateway, where Safe
// Mode flags, suppression, policy and the audit log apply. Do not re-add either scope here.


let isSigningIn = false;
let cachedAccessToken: string | null = null;

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to get access token from Firebase Auth');
    }

    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
};

export const getFirebaseIdToken = async (): Promise<string | null> => {
  const user = auth.currentUser;
  if (user) {
    return await user.getIdToken();
  }
  return null;
};
