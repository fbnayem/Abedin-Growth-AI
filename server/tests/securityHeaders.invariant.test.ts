import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { contentSecurityPolicy, securityHeaders } from '../middleware/securityHeaders';

/**
 * INVARIANTS FOR THE CONTENT SECURITY POLICY (addendum §35).
 *
 * There was no CSP at all — the string did not appear once in the repository. This origin
 * renders untrusted content (inbound email text from strangers) and holds a live Google OAuth
 * token in memory, so an injected script here reads the operator's mailbox and sends as them.
 *
 * The hard part of a CSP is not writing one, it is keeping it true. Two failure modes are
 * specifically tested for:
 *
 *   - A policy that drifts from the page. Someone adds a `<script src>` and the policy blocks
 *     it, or worse, someone adds `'unsafe-inline'` to unblock it and the policy stops meaning
 *     anything. The origins here are checked AGAINST THE ACTUAL HTML rather than against a
 *     list somebody typed.
 *   - A policy that is quietly loosened. Production must not permit `'unsafe-inline'` or
 *     `'unsafe-eval'` for scripts, and that is asserted on the production policy directly
 *     rather than by running in production.
 */

const prod = contentSecurityPolicy({ development: false });
const dev = contentSecurityPolicy({ development: true });

/** The directives of a policy, as a map, so a merged directive is visible. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    out.set(tokens[0], tokens.slice(1));
  }
  return out;
}

/** The `src` origins of every external script in an HTML file. */
function scriptOrigins(html: string): string[] {
  const origins: string[] = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/g)) {
    const src = m[1];
    if (src.startsWith('http')) origins.push(new URL(src).origin);
  }
  return [...new Set(origins)];
}

/** Does `sources` permit `origin`, allowing for a single-level wildcard host? */
function permits(sources: string[], origin: string): boolean {
  return sources.some((source) => {
    if (source === origin) return true;
    if (!source.startsWith('https://*.')) return false;
    const suffix = source.slice('https://*.'.length);
    return origin.startsWith('https://') && origin.endsWith('.' + suffix);
  });
}

describe('0. the headers are mounted, and mounted early enough to cover everything', () => {
  /**
   * This exists because a mutant survived: deleting `app.use(securityHeaders())` from server.ts
   * entirely passed the whole gate. Every assertion below this one is about a policy that
   * nothing was sending.
   *
   * Ordering is asserted too, not just presence. A security header mounted after a route is a
   * header that route does not have, and the failure is invisible — the page works, and the
   * protection is simply absent on the paths that matter most.
   */
  const serverEntry = readFileSync('server.ts', 'utf8');

  it('server.ts mounts the middleware', () => {
    expect(serverEntry).toMatch(/app\.use\(\s*securityHeaders\(\s*\)\s*\)/);
  });

  it('mounts it before any router that answers a request', () => {
    const headers = serverEntry.indexOf('app.use(securityHeaders(');
    expect(headers, 'securityHeaders is not mounted at all').toBeGreaterThan(-1);

    for (const later of ['app.use("/api/outbox"', 'app.use("/api/autonomy"', 'app.use(vite.middlewares)']) {
      const at = serverEntry.indexOf(later);
      expect(at, `${later} not found — this ordering check has gone stale`).toBeGreaterThan(-1);
      expect(headers, `securityHeaders is mounted after ${later}`).toBeLessThan(at);
    }
  });

  it('mounts it before the body parser and the auth chain', () => {
    const headers = serverEntry.indexOf('app.use(securityHeaders(');
    expect(headers).toBeLessThan(serverEntry.indexOf('app.use(express.json())'));
  });
});

describe('1. the policy is well formed', () => {
  it('every directive appears exactly once', () => {
    // The failure this guards is not a syntax error. A repeated or merged directive is
    // accepted by browsers and silently changes what is permitted.
    for (const policy of [prod, dev]) {
      const names = policy
        .split(';')
        .map((p) => p.trim().split(/\s+/)[0])
        .filter(Boolean);
      expect(new Set(names).size, `duplicate directive in: ${policy}`).toBe(names.length);
    }
  });

  it('declares the directives that close the defaults', () => {
    const d = directives(prod);
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    // Without base-uri, an injected <base> repoints every relative script URL in the page.
    expect(d.get('base-uri')).toEqual(["'self'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'self'"]);
  });
});

describe('2. production is not quietly loosened', () => {
  it('does not permit inline or eval scripts', () => {
    // The concession that makes most policies decorative. The production bundle has no inline
    // script, so there is nothing to concede to.
    const scriptSrc = directives(prod).get('script-src') ?? [];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it('does not permit websocket connections', () => {
    const connectSrc = directives(prod).get('connect-src') ?? [];
    expect(connectSrc).not.toContain('ws:');
    expect(connectSrc).not.toContain('wss:');
  });

  it('upgrades insecure requests', () => {
    expect(prod).toContain('upgrade-insecure-requests');
  });

  it('development is looser, and only development', () => {
    // Asserted so the two cannot silently converge — either by production gaining the
    // concessions, or by development losing them and the dev server breaking.
    const devScript = directives(dev).get('script-src') ?? [];
    expect(devScript).toContain("'unsafe-inline'");
    expect(devScript).toContain("'unsafe-eval'");
    expect(directives(dev).get('connect-src')).toContain('ws:');
    // upgrade-insecure-requests would rewrite http://localhost asset requests to https.
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
});

describe('3. the policy permits what the page actually loads', () => {
  /**
   * Checked against the HTML rather than against a list. Adding a `<script src>` from a new
   * origin without permitting it fails here, at build time, rather than in a browser console
   * that nobody is watching.
   */
  it('every external script origin in index.html is permitted', () => {
    const origins = scriptOrigins(readFileSync('index.html', 'utf8'));
    expect(origins.length, 'no external scripts found — is the parser working?').toBeGreaterThan(
      0
    );
    const scriptSrc = directives(prod).get('script-src') ?? [];
    for (const origin of origins) {
      expect(permits(scriptSrc, origin), `${origin} is not permitted by script-src`).toBe(true);
    }
  });

  it('every external script origin in the BUILT html is permitted', () => {
    // The source looking clean is not the artifact being clean — the lesson from the
    // `gmail.send` scope that survived in the bundle after the source was fixed.
    if (!existsSync('dist/index.html')) return;
    const scriptSrc = directives(prod).get('script-src') ?? [];
    for (const origin of scriptOrigins(readFileSync('dist/index.html', 'utf8'))) {
      expect(permits(scriptSrc, origin), `${origin} is not permitted by script-src`).toBe(true);
    }
  });

  it('the built html has no inline script, which is what lets production be strict', () => {
    if (!existsSync('dist/index.html')) return;
    const html = readFileSync('dist/index.html', 'utf8');
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
      (m) => m[1].trim().length > 0
    );
    expect(inline.length, 'an inline script appeared in the build').toBe(0);
  });

  it('permits the Google APIs the client calls', () => {
    const connectSrc = directives(prod).get('connect-src') ?? [];
    for (const origin of [
      'https://gmail.googleapis.com',
      'https://www.googleapis.com',
      'https://identitytoolkit.googleapis.com',
      'https://securetoken.googleapis.com',
    ]) {
      expect(permits(connectSrc, origin), `${origin} is not permitted by connect-src`).toBe(true);
    }
  });

  it('permits the sign-in popup and the Firebase auth helper frame', () => {
    const frameSrc = directives(prod).get('frame-src') ?? [];
    expect(permits(frameSrc, 'https://accounts.google.com')).toBe(true);
    expect(permits(frameSrc, 'https://linen-office-320801.firebaseapp.com')).toBe(true);
  });

  it('refuses an origin nobody permitted', () => {
    // The other half: a checker that permits everything would satisfy every assertion above.
    const scriptSrc = directives(prod).get('script-src') ?? [];
    expect(permits(scriptSrc, 'https://evil.example.com')).toBe(false);
    expect(permits(scriptSrc, 'https://accounts.google.com.evil.com')).toBe(false);
  });
});

describe('4. the headers are actually set, and sign-in still works', () => {
  function headersFrom(development: boolean): Record<string, string> {
    const set: Record<string, string> = {};
    const res: any = { setHeader: (k: string, v: string) => (set[k] = v) };
    let nextCalled = false;
    securityHeaders(development)({} as any, res, () => {
      nextCalled = true;
    });
    expect(nextCalled, 'the middleware did not call next()').toBe(true);
    return set;
  }

  it('sets the policy and the supporting headers', () => {
    const h = headersFrom(false);
    expect(h['Content-Security-Policy']).toBe(prod);
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toContain('microphone=()');
  });

  it('COOP allows popups — `same-origin` would break Google sign-in silently', () => {
    // The most likely well-meant regression here: tightening this to 'same-origin' severs the
    // opener relationship signInWithPopup needs to return the credential, and the login hangs
    // with no error. Pinned so the tightening fails a test instead of the product.
    expect(headersFrom(false)['Cross-Origin-Opener-Policy']).toBe('same-origin-allow-popups');
  });

  it('development gets the development policy, not the production one', () => {
    expect(headersFrom(true)['Content-Security-Policy']).toBe(dev);
    expect(headersFrom(true)['Content-Security-Policy']).not.toBe(prod);
  });

  describe('the environment decides, and the application does not have to remember', () => {
    /**
     * This exists because a mutant survived. `server.ts` passed
     * `process.env.NODE_ENV !== 'production'`, and replacing that argument with a bare `true`
     * — serving production the development policy, with 'unsafe-inline' and 'unsafe-eval' —
     * passed the whole gate. The tests drove this function directly and nothing checked how
     * the application called it.
     *
     * The decision moved inside as a default, so there is no argument at the call site to get
     * wrong, and these assert the default rather than a source string.
     */
    function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
      const previous = process.env.NODE_ENV;
      try {
        if (value === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = value;
        return fn();
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    }

    const defaulted = (): string => {
      const set: Record<string, string> = {};
      const res: any = { setHeader: (k: string, v: string) => (set[k] = v) };
      securityHeaders()({} as any, res, () => undefined);
      return set['Content-Security-Policy'];
    };

    it('NODE_ENV=production gets the production policy', () => {
      expect(withNodeEnv('production', defaulted)).toBe(prod);
    });

    it('any other value gets the development policy', () => {
      expect(withNodeEnv('development', defaulted)).toBe(dev);
      expect(withNodeEnv('test', defaulted)).toBe(dev);
    });

    it('an UNSET NODE_ENV is treated as development, not as production', () => {
      // Deliberate, and the safer of the two mistakes: an unset environment gets the loose
      // policy and a working dev server, rather than a strict policy silently breaking a
      // local page. Getting it the other way round would ship the loose policy by omission.
      expect(withNodeEnv(undefined, defaulted)).toBe(dev);
    });
  });
});
