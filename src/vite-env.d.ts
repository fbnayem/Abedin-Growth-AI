/// <reference types="vite/client" />

/**
 * The build-time environment this application reads, declared rather than cast.
 *
 * Added when the Firebase Auth config moved out of the tracked `firebase-applet-config.json`
 * and into `.env`. Without this, `import.meta.env` is not a known property and the only way to
 * reach it is `(import.meta as any).env` — a cast in exactly the position where the compiler
 * would otherwise tell you that a variable name is misspelled, which for configuration read at
 * build time means an `undefined` that reaches production silently.
 *
 * Every variable is optional. Vite substitutes only the ones that are set, so a missing one is
 * genuinely absent at runtime, and `resolveFirebaseAuthConfig` is what turns that absence into
 * a message naming the variable rather than an opaque failure at the first sign-in.
 */
interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
