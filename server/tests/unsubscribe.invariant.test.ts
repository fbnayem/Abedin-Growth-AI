import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  unsubscribeConfig,
  usableAppUrl,
  unsubscribeToken,
  identityFromToken,
  unsubscribeUrl,
  unsubscribeUrlFor,
  listUnsubscribeHeaders,
  unsubscribeFooterHtml,
  MIN_SECRET_LENGTH,
  MAX_TOKEN_LENGTH,
  type UnsubscribeConfig,
} from '../domain/unsubscribe';
import { isUnauthenticatedApiPath } from '../middleware/authAllowlist';

/**
 * INVARIANTS FOR THE OPT-OUT (addendum S26).
 *
 * `List-Unsubscribe` existed in this repository twice, both INBOUND: `automatedMail.ts` reads
 * it off arriving mail to decide that somebody else's message is bulk. Nothing emitted one.
 *
 * The consequence is the finding, not the missing header. `actionGateway.ts` refuses to send
 * when `contactData.unsubscribed === true` — a suppression check with no writer, so no
 * recipient could ever make it fire. Real enforcement, unreachable control: the same shape as
 * the autonomy lock, one layer out.
 */

const SECRET = 'x'.repeat(MIN_SECRET_LENGTH);
const CONFIG: UnsubscribeConfig = { secret: SECRET, appUrl: 'https://app.example.com' };
const IDENTITY = { orgId: 'acme', contactId: 'contact-7' };

describe('1. the token is unforgeable, portable across time, and not portable across tenants', () => {
  it('round-trips the identity it was minted for', () => {
    const token = unsubscribeToken(IDENTITY, CONFIG)!;
    const parsed = identityFromToken(token, CONFIG);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.identity).toEqual(IDENTITY);
  });

  it('is deterministic, so a year-old email still unsubscribes', () => {
    // An opt-out that expires stops working exactly when somebody finally gets round to using
    // it, and the recipient's alternative is the spam button.
    expect(unsubscribeToken(IDENTITY, CONFIG)).toBe(unsubscribeToken(IDENTITY, CONFIG));
  });

  it('does not carry the email address', () => {
    // Unsubscribe URLs reach provider logs, referrer headers and screenshots.
    const token = unsubscribeToken({ orgId: 'acme', contactId: 'c1' }, CONFIG)!;
    const decoded = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
    expect(decoded).not.toMatch(/@/);
  });

  it('a token minted under one secret does not verify under another', () => {
    const token = unsubscribeToken(IDENTITY, CONFIG)!;
    const other = { ...CONFIG, secret: 'y'.repeat(MIN_SECRET_LENGTH) };
    expect(identityFromToken(token, other).ok).toBe(false);
  });

  it('a token for one tenant names that tenant, and cannot be replayed as another', () => {
    const a = unsubscribeToken({ orgId: 'acme', contactId: 'c1' }, CONFIG)!;
    const b = unsubscribeToken({ orgId: 'other', contactId: 'c1' }, CONFIG)!;
    expect(a).not.toBe(b);
    const parsed = identityFromToken(a, CONFIG);
    expect(parsed.ok && parsed.identity.orgId).toBe('acme');
  });

  it('any tampering with the payload is refused', () => {
    const token = unsubscribeToken(IDENTITY, CONFIG)!;
    const [version, payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ o: 'acme', c: 'victim' }), 'utf8')
      .toString('base64url')
      .replace(/=+$/, '');

    for (const [why, candidate] of [
      ['payload swapped, signature kept', `${version}.${forged}.${signature}`],
      ['signature truncated', `${version}.${payload}.${signature.slice(0, -1)}`],
      ['signature lengthened', `${version}.${payload}.${signature}A`],
      ['signature emptied', `${version}.${payload}.`],
      ['version changed', `v2.${payload}.${signature}`],
      ['parts reordered', `${version}.${signature}.${payload}`],
      ['a fourth part appended', `${token}.extra`],
      ['payload alone', payload],
      ['empty', ''],
    ] as Array<[string, string]>) {
      expect(identityFromToken(candidate, CONFIG).ok, why).toBe(false);
    }
  });

  it('a malformed token is refused rather than throwing', () => {
    // `timingSafeEqual` THROWS on a length mismatch. An exception here is a 500 on a forged
    // token, which is both an error-rate signal an attacker controls and an oracle.
    for (const bad of [null, undefined, 42, {}, [], 'a.b', 'a.b.c.d', 'v1..', 'v1.@@@.###']) {
      expect(() => identityFromToken(bad, CONFIG)).not.toThrow();
      expect(identityFromToken(bad, CONFIG).ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('an over-long token is refused before any work is done', () => {
    const long = `v1.${'A'.repeat(MAX_TOKEN_LENGTH)}.${'B'.repeat(64)}`;
    expect(identityFromToken(long, CONFIG).ok).toBe(false);
  });

  it('an identity that would change a store path cannot be minted', () => {
    // The contact id becomes a document id in `organizations/{org}/contacts/{id}`. A `/` here
    // would address a different collection entirely.
    for (const bad of ['a/b', '.', '..', '', 'x'.repeat(201)]) {
      expect(unsubscribeToken({ orgId: 'acme', contactId: bad }, CONFIG), bad).toBeNull();
      expect(unsubscribeToken({ orgId: bad, contactId: 'c1' }, CONFIG), bad).toBeNull();
    }
  });

  it('a signed payload naming an unusable contact is still refused', () => {
    // A signature proves who wrote a value, not that the value is safe to concatenate into a
    // path. Re-checked after verification, so a token minted by an older or laxer build — or
    // with a leaked secret — cannot redirect the write.
    const payload = Buffer.from(JSON.stringify({ o: 'acme', c: '../../etc' }), 'utf8')
      .toString('base64url')
      .replace(/=+$/, '');
    const material = `v1.${payload}`;
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', SECRET)
      .update(material)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const wellSigned = `${material}.${sig}`;
    // The signature is genuine — this is our own secret.
    expect(wellSigned.split('.')).toHaveLength(3);
    expect(identityFromToken(wellSigned, CONFIG).ok).toBe(false);
  });
});

describe('2. no working link means no send', () => {
  it('an unset or short secret produces no config', () => {
    for (const secret of [undefined, '', '   ', 'short', 'x'.repeat(MIN_SECRET_LENGTH - 1)]) {
      expect(
        unsubscribeConfig({ UNSUBSCRIBE_SECRET: secret, APP_URL: 'https://a.example.com' }),
        `accepted ${JSON.stringify(secret)}`
      ).toBeNull();
    }
    expect(
      unsubscribeConfig({ UNSUBSCRIBE_SECRET: SECRET, APP_URL: 'https://a.example.com' })
    ).not.toBeNull();
  });

  /**
   * THE DECISION THIS WHOLE ITEM TURNS ON.
   *
   * The permissive reading of "we could not build an unsubscribe link" is to send anyway and
   * omit the header. It is also the reading that fails silently: the send succeeds, the
   * recipient has no way to stop it, and nothing reports the absence. §14 applied to the
   * recipient's interest rather than the sender's.
   */
  it('unsubscribeUrlFor REFUSES rather than returning an empty URL', () => {
    const refused = unsubscribeUrlFor(IDENTITY, { APP_URL: 'https://a.example.com' });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toMatch(/refusing to send/i);

    const alsoRefused = unsubscribeUrlFor(IDENTITY, { UNSUBSCRIBE_SECRET: SECRET });
    expect(alsoRefused.ok).toBe(false);
  });

  it('a configured deployment produces a URL under its own origin', () => {
    const result = unsubscribeUrlFor(IDENTITY, {
      UNSUBSCRIBE_SECRET: SECRET,
      APP_URL: 'https://app.example.com/',
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.url).toMatch(
      /^https:\/\/app\.example\.com\/api\/unsubscribe\/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    );
  });

  it('an unmintable identity refuses the send too', () => {
    const result = unsubscribeUrlFor(
      { orgId: 'acme', contactId: '' },
      { UNSUBSCRIBE_SECRET: SECRET, APP_URL: 'https://a.example.com' }
    );
    expect(result.ok).toBe(false);
  });

  it('the config is read at CALL time, not snapshotted at import', () => {
    // S46 is the finding that ES module imports are hoisted above `dotenv.config()`, so the
    // five REAL_* flags were snapshotted before `.env` had been read and the enforcement point
    // disagreed with the operator display. A module-level `const config = ...` here would
    // reproduce that exactly.
    const before = unsubscribeUrlFor(IDENTITY, {});
    expect(before.ok).toBe(false);
    const after = unsubscribeUrlFor(IDENTITY, {
      UNSUBSCRIBE_SECRET: SECRET,
      APP_URL: 'https://a.example.com',
    });
    expect(after.ok).toBe(true);
  });
});

describe('3. the URL cannot break out of a header or an href', () => {
  it('APP_URL is restricted to characters that are safe in both', () => {
    for (const good of [
      'https://app.example.com',
      'https://app.example.com:8443',
      'https://sub.domain.example.com/base',
      'http://localhost:3000',
      'http://localhost',
    ]) {
      expect(usableAppUrl(good), `rejected ${good}`).toBe(true);
    }

    for (const bad of [
      '',
      'ftp://app.example.com',
      'http://app.example.com', // plain http off localhost: the token would travel in clear
      'https://app.example.com"onload=x',
      "https://app.example.com'>",
      'https://app.example.com/<script>',
      'https://app.example.com\r\nBcc: victim@example.com',
      'https://app.example.com\nX-Injected: 1',
      'https://app.example.com/ space',
      'javascript:alert(1)',
      'https://' + 'a'.repeat(300),
    ]) {
      expect(usableAppUrl(bad), `accepted ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('nothing hostile survives the whole chain into a header or an anchor', () => {
    // The end-to-end version of the check above: config, token, URL, header, footer.
    for (const hostile of [
      'https://a.example.com\r\nBcc: victim@example.com',
      'https://a.example.com">x',
      'https://a.example.com/<img src=x onerror=1>',
    ]) {
      const result = unsubscribeUrlFor(IDENTITY, {
        UNSUBSCRIBE_SECRET: SECRET,
        APP_URL: hostile,
      });
      expect(result.ok, `${hostile} produced a URL`).toBe(false);
    }

    const clean = unsubscribeUrl(unsubscribeToken(IDENTITY, CONFIG)!, CONFIG);
    expect(clean).not.toMatch(/[\r\n"'<>\s]/);
    expect(listUnsubscribeHeaders(clean)['List-Unsubscribe']).toBe(`<${clean}>`);
    expect(unsubscribeFooterHtml(clean)).toContain(`href="${clean}"`);
  });

  /**
   * THE ONE PROPERTY IN THIS FILE THAT IS NOT PROVED BY AN OUTPUT ASSERTION.
   *
   * Replacing `timingSafeEqual` with `!==` survived mutation testing. Measured before being
   * written off: the two versions agree on all 95 probed inputs — a valid token, every
   * single-character mutation of its signature, every truncation. They are output-equivalent
   * by construction and differ only in how long a rejection takes.
   *
   * A wall-clock assertion in a unit suite is a flaky test, not a proof. So this checks the
   * source, and its weakness is stated rather than hidden: a source assertion cannot tell
   * `timingSafeEqual(a, b)` from `!timingSafeEqual(a, b)`. Earlier in this hardening pass an
   * assertion of exactly that kind passed on a gateway mutant that had inverted the condition
   * it was asserting.
   */
  it('the signature comparison is constant-time (source-level; see the note)', () => {
    const domain = readFileSync('server/domain/unsubscribe.ts', 'utf8');
    expect(domain).toContain("import { createHmac, timingSafeEqual } from 'node:crypto'");
    expect(domain).toMatch(/if \(given\.length !== want\.length \|\| !timingSafeEqual\(given, want\)\)/);
    // The length check is separate on purpose: `timingSafeEqual` THROWS on a length mismatch
    // rather than returning false, and that exception would be a 500 on a forged token.
    expect(domain).not.toMatch(/if \(signature [!=]==? expected\)/);
  });

  it('that check would fail on the version that leaks', () => {
    const leaky = 'if (signature !== expected) {\n  return { ok: false };\n}';
    expect(/if \(given\.length !== want\.length \|\| !timingSafeEqual\(given, want\)\)/.test(leaky)).toBe(
      false
    );
    expect(/if \(signature [!=]==? expected\)/.test(leaky)).toBe(true);
  });

  it('the one-click header is exactly what RFC 8058 specifies', () => {
    // Any other spelling and the provider treats the message as having no one-click
    // unsubscribe, which is the case this exists to remove.
    expect(listUnsubscribeHeaders('https://x/y')['List-Unsubscribe-Post']).toBe(
      'List-Unsubscribe=One-Click'
    );
  });
});

describe('4. the unauthenticated allowlist admits the route and nothing near it', () => {
  it('admits the unsubscribe path', () => {
    const token = unsubscribeToken(IDENTITY, CONFIG)!;
    expect(isUnauthenticatedApiPath(`/unsubscribe/${token}`)).toBe(true);
  });

  it('keeps admitting the machine endpoints it already did', () => {
    for (const p of ['/readiness', '/health', '/signature/webhook', '/webhooks/gmail']) {
      expect(isUnauthenticatedApiPath(p), p).toBe(true);
    }
  });

  /**
   * The pattern is anchored and its character class excludes `/`, which is what separates it
   * from `req.path.includes('/webhook')` — the substring test P0.4 removed, which made every
   * path merely containing the word public.
   */
  it('admits nothing else, including everything adjacent to it', () => {
    for (const p of [
      '/unsubscribe',
      '/unsubscribe/',
      '/unsubscribe/tok/../../admin',
      '/unsubscribe/tok/extra',
      '/unsubscribe/tok?x=1',
      '/x/unsubscribe/tok',
      '/api/unsubscribe/tok',
      '/settings/webhooks',
      '/campaigns/webhook-preview',
      '/webhooks/gmail/replay',
      '/contacts',
      '/outbox',
      '/',
    ]) {
      expect(isUnauthenticatedApiPath(p), `${p} was admitted without a credential`).toBe(false);
    }
  });
});

describe('5. the send path emits it, and the confirmation page interpolates nothing', () => {
  const gmail = readFileSync('server/services/gmail.service.ts', 'utf8');
  const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
  const routes = readFileSync('server/routes/unsubscribe.routes.ts', 'utf8');

  it('the header goes through headerLine like every other header', () => {
    // S16: the reply subject is derived from the INBOUND subject, and raw interpolation let a
    // customer end the header with CR-LF and write their own `Bcc:`. A header added later by
    // string concatenation would reopen that on a value the send path did not check.
    expect(gmail).toMatch(/headerLine\('List-Unsubscribe',/);
    expect(gmail).toMatch(/headerLine\('List-Unsubscribe-Post',/);
  });

  it('the gateway refuses when there is no URL, rather than dropping the header', () => {
    expect(gateway).toContain('unsubscribeUrlFor');
    expect(gateway).toMatch(/if \(unsubscribe\.ok === false\)[\s\S]{0,300}?POLICY_BLOCKED/);
  });

  it('that check would fail if the refusal were removed', () => {
    expect(
      /if \(unsubscribe\.ok === false\)[\s\S]{0,300}?POLICY_BLOCKED/.test(
        'const unsubscribe = unsubscribeUrlFor(x);\n await gmailService.sendEmail({});'
      )
    ).toBe(false);
  });

  /**
   * GET MUST NOT UNSUBSCRIBE. That is why RFC 8058 exists.
   *
   * Mail clients, security appliances and link scanners fetch every URL in a message before a
   * human sees it. A GET that changed state would unsubscribe people who never clicked, and
   * the sender would never find out — the recipient simply stops hearing from them.
   */
  it('only POST records an unsubscribe', () => {
    expect(routes).toMatch(/unsubscribeRouter\.get\([\s\S]{0,400}?res\.type\('html'\)/);
    const getBlock = /unsubscribeRouter\.get\([\s\S]*?\n\}\);/.exec(routes)![0];
    expect(getBlock).not.toContain('recordUnsubscribe');
    expect(routes).toMatch(/unsubscribeRouter\.post\([\s\S]{0,600}?recordUnsubscribe/);
  });

  /**
   * THE CONFIRMATION PAGE INTERPOLATES NOTHING A REQUEST CAN REACH.
   *
   * Two halves, because either alone is satisfiable by a page that is still injectable.
   *
   *   1. The template's only substitutions are its own three parameters. (`showForm` selects
   *      between two literal strings; `heading` and `message` are the text.)
   *   2. Every call site passes MODULE CONSTANTS — never `req`, `params`, `query` or a value
   *      derived from them. This is the half that matters: a template with safe parameters is
   *      injectable the moment somebody passes `req.params.token` to it "so the user can see
   *      which link failed".
   *
   * The form posts to `action="?confirmed=1"` — a relative URL that keeps the current path,
   * token included — so the token is never concatenated into HTML at all. Nothing to escape
   * is a smaller property to keep true than escaping correctly.
   */
  it('the confirmation page template interpolates only its own parameters', () => {
    const template = /function page\([\s\S]*?\n\}/.exec(routes)![0];
    const identifiers = new Set(
      (template.match(/\$\{\s*([A-Za-z_$][\w$]*)/g) ?? []).map((m) =>
        m.replace(/^\$\{\s*/, '')
      )
    );
    expect([...identifiers].sort()).toEqual(['heading', 'message', 'showForm']);
    expect(template).toContain('action="?confirmed=1"');
    expect(template).not.toContain('token');
  });

  it('every call site passes constants, never anything off the request', () => {
    // The half that actually matters. A template with safe parameters becomes injectable the
    // moment somebody passes `req.params.token` to it "so the user can see which link failed".
    // The lookbehind skips the declaration and leaves the invocations.
    const calls = routes.match(/(?<!function )\bpage\(([^)]*)\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);

    const ARGUMENTS_SEEN = new Set<string>();
    for (const call of calls) {
      const normalised = call.replace(/\s+/g, ' ');
      expect(
        /\breq\b|params|query|\bbody\b|token|`/.test(normalised),
        `a call site reaches request data: ${normalised}`
      ).toBe(false);
      for (const arg of normalised.replace(/^page\(|\)$/g, '').split(',')) {
        ARGUMENTS_SEEN.add(arg.trim());
      }
    }

    // Every argument is a module constant, a boolean, or the service's own message — which is
    // itself one of three fixed strings, asserted below.
    const ALLOWED = new Set([
      'CONFIRM_HEADING',
      'CONFIRM_BODY',
      'DONE_HEADING',
      'DONE_BODY',
      'FAILED_HEADING',
      'result.message',
      'true',
      'false',
    ]);
    for (const arg of ARGUMENTS_SEEN) {
      expect(ALLOWED.has(arg), `unexpected argument passed to the page template: ${arg}`).toBe(
        true
      );
    }
  });

  it('the service messages the page renders never quote the token back', () => {
    // `result.message` is the one non-literal argument. It is one of three constants in the
    // service, and this is what keeps it that way: a message built as
    // `Token ${token} is invalid` would put attacker-controlled text into the page and,
    // separately, turn the response into an oracle for guessing tokens.
    const service = readFileSync('server/services/unsubscribe.service.ts', 'utf8');
    const returns = service.match(/message:[^\n]*/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(3);
    for (const line of returns) {
      expect(/\$\{/.test(line), `a message interpolates: ${line}`).toBe(false);
    }
    // And the specific reason a token failed is logged, not returned: "signature does not
    // verify" and "unrecognised version" tell a prober which half of their guess was wrong.
    expect(service).toMatch(/console\.warn\([^)]*parsed\.reason/);
    expect(service).toContain('BAD_TOKEN');
  });

  it('those checks would fail on the page they are meant to prevent', () => {
    // Without this, a pattern set matching nothing satisfies both assertions above on any
    // codebase at all.
    const injectable = 'function page(h: string) {\n  return `<p>${req.params.token}</p>`;\n}';
    const ids = new Set(
      (injectable.match(/\$\{\s*([A-Za-z_$][\w$]*)/g) ?? []).map((m) =>
        m.replace(/^\$\{\s*/, '')
      )
    );
    expect([...ids]).not.toEqual(['heading', 'message', 'showForm']);
    expect(
      /\breq\b|params|query|\bbody\b|token|`/.test('page(FAILED_HEADING, req.params.token, false)')
    ).toBe(true);
    expect(/\$\{/.test('message: `Token ${token} is invalid`')).toBe(true);
  });
});
