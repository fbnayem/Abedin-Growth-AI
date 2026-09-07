import type { Request, Response, NextFunction } from 'express';

/**
 * S35 — THE CONTENT SECURITY POLICY THIS APPLICATION DID NOT HAVE.
 *
 * WHAT WAS MISSING
 * ----------------
 * Nothing. There was no `Content-Security-Policy` header, no `helmet`, and no `<meta
 * http-equiv>` anywhere in the repository — the string did not appear once.
 *
 * That mattered more here than it does in most applications, and the codebase already knew it.
 * `src/services/gmailWorkspaceService.ts` carries this, written when the OAuth token was moved
 * out of `localStorage`:
 *
 *     // With no HTML sanitizer and no CSP in this app (see S35), that is a realistic path,
 *     // so the token now lives in memory only and dies with the tab.
 *
 * The token is memory-only now, which closes the persistence half. A script injected into this
 * origin could still read it out of the running page, call Google as the operator, and exfiltrate
 * every rendered inbox message. This origin renders untrusted content: inbound email text
 * arrives from strangers and is displayed. A CSP is the control that makes an injected script
 * unable to *load* or *reach* anywhere.
 *
 * WHAT THE POLICY PERMITS, AND WHY EACH ONE
 * -----------------------------------------
 * Every origin below was taken from what the application actually loads, not from a template:
 *
 *   script-src   `accounts.google.com` and `apis.google.com` are two `<script src>` tags in
 *                index.html (Google Identity Services and the GAPI loader). The production
 *                bundle has NO inline script — checked in `dist/index.html` — so production
 *                does not permit `'unsafe-inline'`, which is the concession that usually makes
 *                a policy decorative.
 *   connect-src  `*.googleapis.com` covers gmail, the generic API host, identitytoolkit and
 *                securetoken (Firebase Auth). `accounts.google.com` is the sign-in exchange.
 *   frame-src    `signInWithPopup` opens Google's own pages, and the Firebase Auth helper
 *                iframe lives on the project's `*.firebaseapp.com` domain.
 *   style-src    `'unsafe-inline'` is required and is a real weakening. React writes
 *                `style={{...}}` as inline style attributes, which this directive governs.
 *                Removing it means removing every inline style in the UI first; it is not a
 *                thing to claim and not do.
 *   img-src      `data:` and `blob:` for generated content, `*.googleusercontent.com` for the
 *                signed-in user's avatar.
 *
 * `default-src 'self'` with `object-src 'none'` and `base-uri 'self'` closes the rest:
 * `<base>` injection cannot repoint relative script URLs, and no plugin content loads at all.
 *
 * WHY NOT `frame-ancestors 'none'` AND `COOP: same-origin`
 * -------------------------------------------------------
 * `frame-ancestors 'none'` IS set — nothing should embed this console.
 *
 * `Cross-Origin-Opener-Policy` is `same-origin-allow-popups`, NOT `same-origin`, and the
 * difference is the whole sign-in flow. `same-origin` severs the opener relationship for popups,
 * and `signInWithPopup` needs it to hand the credential back; the login would hang with no error
 * anyone could act on. A header that silently breaks authentication is a header that gets
 * deleted along with the rest of them.
 *
 * DEVELOPMENT IS LOOSER, AND SAYS SO
 * ----------------------------------
 * Vite's dev server injects an inline react-refresh preamble, compiles with `eval`, and talks
 * to HMR over a websocket. Development therefore permits `'unsafe-inline'`, `'unsafe-eval'` and
 * `ws:`. Production permits none of the three. The split is a function of one boolean so a test
 * can assert the production policy directly rather than trusting the environment it runs in.
 */

export interface CspOptions {
  /** Development permits what Vite needs; production permits none of it. */
  readonly development: boolean;
}

const GOOGLE_SCRIPTS = ['https://accounts.google.com', 'https://apis.google.com'];

const GOOGLE_APIS = [
  'https://*.googleapis.com',
  'https://accounts.google.com',
  'https://*.firebaseapp.com',
];

const GOOGLE_FRAMES = [
  'https://accounts.google.com',
  'https://apis.google.com',
  'https://*.firebaseapp.com',
];

/**
 * Build the policy. Pure, so the production policy can be asserted without being in production.
 *
 * The directives are assembled from arrays rather than written as one string because the string
 * form is where a missing semicolon silently merges two directives — and a merged directive is
 * not a syntax error, it is a policy that permits something nobody intended.
 */
export function contentSecurityPolicy(options: CspOptions): string {
  const { development } = options;

  const scriptSrc = ["'self'", ...GOOGLE_SCRIPTS];
  if (development) scriptSrc.push("'unsafe-inline'", "'unsafe-eval'");

  const connectSrc = ["'self'", ...GOOGLE_APIS];
  if (development) connectSrc.push('ws:', 'wss:');

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['object-src', ["'none'"]],
    ['frame-ancestors', ["'none'"]],
    ['form-action', ["'self'"]],
    ['script-src', scriptSrc],
    // 'unsafe-inline' is genuinely required: React renders `style={{...}}` as inline style
    // attributes, which this directive governs. Stated rather than quietly included.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', connectSrc],
    ['frame-src', GOOGLE_FRAMES],
  ];

  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);

  // Only in production: in development the dev server is plain http on localhost, and
  // upgrade-insecure-requests would rewrite every asset request to https and break the page.
  if (!development) policy.push('upgrade-insecure-requests');

  return policy.join('; ');
}

/**
 * The headers this application sets on every response.
 *
 * Mounted before anything that can answer a request, so a route added later is covered by
 * default rather than by somebody remembering. That ordering is the point: a security header
 * applied per-route is a security header that is missing from the next route.
 */
export function securityHeaders(
  development: boolean = process.env.NODE_ENV !== 'production'
) {
  // DEFAULTED HERE, NOT DECIDED AT THE CALL SITE, and that is the fix for a survived mutant.
  //
  // `server.ts` used to pass `process.env.NODE_ENV !== 'production'`. Replacing that argument
  // with a bare `true` — serving the development policy, with 'unsafe-inline' and 'unsafe-eval',
  // to production — passed the entire gate, because the tests exercised this function directly
  // and nothing checked how the application called it.
  //
  // Moving the decision inside removes the argument there is to get wrong, and puts it where a
  // test can set NODE_ENV and assert which policy comes out. The parameter remains so tests can
  // drive both branches without touching the environment.
  const csp = contentSecurityPolicy({ development });

  return function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Content-Security-Policy', csp);

    // A response whose type is guessed is a response that can be executed. This matters for
    // the JSON API: without it, a browser may sniff a JSON body containing attacker text as
    // HTML and run it.
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // Referrers leak. A conversation id or contact id in a path is not something to hand to
    // every external image host the page happens to load.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Nothing in this product uses any of these, so nothing loses anything by their absence —
    // and an injected script cannot turn on a microphone that was never permitted.
    res.setHeader(
      'Permissions-Policy',
      'geolocation=(), microphone=(), camera=(), payment=(), usb=()'
    );

    // `same-origin-allow-popups`, NOT `same-origin`: signInWithPopup needs the opener
    // relationship to return the credential. See the header comment.
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

    next();
  };
}
