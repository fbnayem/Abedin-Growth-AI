import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * S26 — THE OPT-OUT THAT WAS ONLY EVER READ, NEVER OFFERED.
 *
 * WHAT WAS WRONG
 * --------------
 * `List-Unsubscribe` appears in this repository exactly twice, and both are INBOUND:
 * `server/domain/automatedMail.ts:192` treats its presence on an arriving message as evidence
 * that the message is bulk mail and should not be replied to. Nothing has ever emitted one.
 *
 * So the system could recognise that somebody else's mail carried an opt-out, and offered
 * none of its own. The gateway refuses to send to a contact whose record says
 * `unsubscribed === true` (`actionGateway.ts:645`) — a check with no way for a recipient to
 * ever make it true. The suppression enforcement was real and unreachable, which is the same
 * finding as the autonomy lock one commit earlier.
 *
 * WHY A HEADER AND NOT A LINK IN THE BODY
 * ---------------------------------------
 * Both, but the header is the part that matters. A footer link requires the recipient to find
 * it, and a recipient who cannot find it presses the spam button instead — which damages the
 * sending domain for every other recipient. `List-Unsubscribe` puts the control in the mail
 * client's own chrome, and RFC 8058's one-click variant lets the provider act on it without
 * the recipient leaving their inbox.
 *
 * THE TOKEN IS AN HMAC, NOT A DATABASE ROW
 * ----------------------------------------
 * Stateless: the token carries the tenant and the contact, signed. Three consequences that
 * were the reason for choosing it.
 *
 *   - No write at send time, so minting cannot fail halfway and leave a message carrying a
 *     dead link.
 *   - The same contact always gets the same link, so an unsubscribe from a year-old message
 *     still works. An opt-out that expires is an opt-out that stops working precisely when
 *     somebody finally gets round to using it.
 *   - The email address is NOT in the URL. Unsubscribe URLs end up in provider logs, in
 *     referrer headers and in screenshots.
 *
 * IT CANNOT BE MINTED WITHOUT A SECRET, AND THAT REFUSES THE SEND
 * ---------------------------------------------------------------
 * `unsubscribeConfig` returns null when `UNSUBSCRIBE_SECRET` or `APP_URL` is unset or too
 * short, and the gateway treats that as a reason to refuse rather than as permission to send
 * without the header. Emitting `List-Unsubscribe: <https://…>` pointing at a URL that errors
 * is worse than emitting nothing: it is a control that looks present and does nothing, which
 * is the defect this audit keeps finding. §14 applied to the recipient's interest rather than
 * the sender's.
 */

/** The identity an unsubscribe token carries. Tenant included: a token is not portable. */
export interface UnsubscribeIdentity {
  readonly orgId: string;
  readonly contactId: string;
}

export interface UnsubscribeConfig {
  readonly secret: string;
  readonly appUrl: string;
}

export type TokenParse =
  | { readonly ok: true; readonly identity: UnsubscribeIdentity }
  | { readonly ok: false; readonly reason: string };

/**
 * Shorter than this is not a secret, it is a placeholder somebody meant to replace.
 *
 * 32 characters because the failure this prevents is a deployment that sets
 * `UNSUBSCRIBE_SECRET=changeme` and ships forgeable opt-out links, which would let anyone
 * unsubscribe any contact whose id they could guess.
 */
export const MIN_SECRET_LENGTH = 32;

/** A conservative bound: a token is a fixed shape, and anything longer is not one. */
export const MAX_TOKEN_LENGTH = 512;

const VERSION = 'v1';

/**
 * The configuration, read from the environment AT CALL TIME.
 *
 * Not a module-level snapshot, and that is the whole reason this is a function. `config` in
 * `server/config/environment.ts` is evaluated on import, and S46 is the finding that ES module
 * imports are hoisted above `dotenv.config()` — so the five `REAL_*` flags were snapshotted
 * before `.env` had been read, and the enforcement point and the operator display disagreed
 * about what was enabled. Reading here means a value set in `.env` is the value used.
 */
export function unsubscribeConfig(env: NodeJS.ProcessEnv = process.env): UnsubscribeConfig | null {
  const secret = typeof env.UNSUBSCRIBE_SECRET === 'string' ? env.UNSUBSCRIBE_SECRET.trim() : '';
  const appUrl = typeof env.APP_URL === 'string' ? env.APP_URL.trim().replace(/\/+$/, '') : '';
  if (secret.length < MIN_SECRET_LENGTH) return null;
  if (!usableAppUrl(appUrl)) return null;
  return { secret, appUrl };
}

/**
 * An origin this system is willing to put in somebody else's inbox.
 *
 * STRICTER THAN "starts with https", and the strictness is doing a job. The resulting URL is
 * concatenated into a `List-Unsubscribe` header and into an `href` in an HTML body. A value
 * carrying a quote, an angle bracket, whitespace or a newline would break out of one or both,
 * and `APP_URL` is a deployment-time string that nothing else in this system validates.
 *
 * The alternative — escaping it at each of the three places it is used — is three chances to
 * forget. An allowlist of characters an origin may contain has one.
 *
 * HTTPS, or localhost for development. RFC 8058 requires HTTPS for one-click, and a token in
 * a cleartext URL is a token anyone on the path can replay to unsubscribe that contact.
 */
export function usableAppUrl(appUrl: string): boolean {
  if (appUrl.length === 0 || appUrl.length > 255) return false;
  if (/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~\-\/]*)?$/.test(appUrl)) return true;
  return /^http:\/\/localhost(:[0-9]{1,5})?(\/[A-Za-z0-9._~\-\/]*)?$/.test(appUrl);
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(secret: string, material: string): string {
  return b64url(createHmac('sha256', secret).update(material).digest());
}

/**
 * Whether a value can be half of an unsubscribe identity.
 *
 * The same rules as `assertDocumentId` in `server/store/index.ts`, applied BEFORE the value is
 * signed rather than after it comes back: a `/` in a contact id would change the shape of the
 * store path the unsubscribe writes to, and a token is a thing this system asks itself to
 * trust later.
 */
function usableSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes('/') &&
    value !== '.' &&
    value !== '..'
  );
}

/**
 * Mint the token for one contact.
 *
 * Deterministic: the same identity and secret always produce the same token, which is what
 * makes an old message's link keep working. Returns null rather than throwing for an
 * unusable identity, so a caller that cannot supply one refuses the send instead of sending
 * mail carrying a broken control.
 */
export function unsubscribeToken(
  identity: UnsubscribeIdentity,
  config: UnsubscribeConfig
): string | null {
  if (!usableSegment(identity.orgId) || !usableSegment(identity.contactId)) return null;
  const payload = b64url(
    Buffer.from(JSON.stringify({ o: identity.orgId, c: identity.contactId }), 'utf8')
  );
  const material = `${VERSION}.${payload}`;
  return `${material}.${sign(config.secret, material)}`;
}

/**
 * Verify a token and recover the identity it names.
 *
 * THE SIGNATURE IS CHECKED BEFORE THE PAYLOAD IS DECODED. Parsing attacker-supplied JSON and
 * then deciding whether to trust it inverts the order that matters: everything the parser
 * touches would be reachable by anyone, signature or not.
 *
 * The comparison is `timingSafeEqual` over equal-length buffers. A `===` on the signature
 * leaks its length and prefix through timing, and this endpoint is unauthenticated by
 * necessity — the only thing standing between an anonymous caller and the ability to
 * unsubscribe an arbitrary contact is that they cannot produce this value.
 *
 * THAT LAST LINE IS NOT COVERED BY AN OUTPUT ASSERTION, AND IT CANNOT BE.
 * ----------------------------------------------------------------------
 * Replacing `timingSafeEqual` with `signature !== expected` was mutation-tested and SURVIVED
 * the whole gate. Before writing a test for it, the two versions were measured against 95
 * inputs — a valid token, every single-character mutation of its signature, and every
 * truncation of it. Identical results on all 95. The mutant is output-equivalent by
 * construction: both answer "do these bytes match", and they differ only in how long they take
 * to say no.
 *
 * So no assertion on the return value can distinguish them, and a wall-clock assertion in a
 * unit suite is a flaky test rather than a proof. What `unsubscribe.invariant.test.ts` does
 * instead is check the SOURCE for the constant-time call, with a self-check proving the pattern
 * can fail. That is a weaker mechanism than the rest of this file has, and it is recorded as
 * weaker rather than presented as coverage: a source assertion cannot tell
 * `timingSafeEqual(a, b)` from `!timingSafeEqual(a, b)`, which is exactly how a substring
 * assertion on the gateway passed on an inverted `isIrreversible` check earlier in this
 * hardening pass.
 */
export function identityFromToken(token: unknown, config: UnsubscribeConfig): TokenParse {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'No token.' };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'Token is too long to be one of ours.' };
  }

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Token is not in three parts.' };

  const [version, payload, signature] = parts;
  if (version !== VERSION) return { ok: false, reason: 'Unrecognised token version.' };
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) {
    return { ok: false, reason: 'Token contains characters no token of ours contains.' };
  }

  const expected = sign(config.secret, `${VERSION}.${payload}`);
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // Length is compared separately because `timingSafeEqual` THROWS on a length mismatch
  // rather than returning false, and an exception here would be a 500 on a forged token.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'Signature does not verify.' };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'Signed payload is not readable.' };
  }
  if (decoded === null || typeof decoded !== 'object') {
    return { ok: false, reason: 'Signed payload is not an object.' };
  }
  const record = decoded as Record<string, unknown>;
  if (!usableSegment(record.o) || !usableSegment(record.c)) {
    // Reachable only if the secret leaked or a token was minted by an older, laxer build.
    // Re-checked rather than assumed: a signature proves who wrote a value, not that the
    // value is safe to concatenate into a datastore path.
    return { ok: false, reason: 'Signed payload does not name a usable contact.' };
  }
  return { ok: true, identity: { orgId: record.o, contactId: record.c } };
}

/** Where the recipient's mail client sends them, or where the provider POSTs. */
export function unsubscribeUrl(token: string, config: UnsubscribeConfig): string {
  return `${config.appUrl}/api/unsubscribe/${token}`;
}

export type UnsubscribeUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The unsubscribe URL for one send, or the reason there is not one.
 *
 * THIS RETURNS A REFUSAL RATHER THAN AN EMPTY STRING, and the gateway treats the refusal as a
 * reason not to send. That is the load-bearing decision in this file.
 *
 * The alternative — send anyway, omit the header — is how an opt-out mechanism quietly stops
 * existing: one deployment forgets `UNSUBSCRIBE_SECRET`, mail goes out with no way to opt out,
 * and nothing anywhere reports it because the send succeeded. §14 says an unknown must not
 * resolve to permission; here the unknown is "can this recipient stop us?" and the permissive
 * reading is to send.
 *
 * Not gated on message class. This system has one send path and no campaign engine, so there
 * is no reliable signal for "bulk" versus "reply" to branch on — and choosing wrong in the
 * permissive direction means bulk mail with no opt-out. An unsubscribe offered on a reply is a
 * recipient given a control they did not need; the reverse is a recipient who cannot stop us.
 */
export function unsubscribeUrlFor(
  identity: UnsubscribeIdentity,
  env: NodeJS.ProcessEnv = process.env
): UnsubscribeUrlResult {
  const config = unsubscribeConfig(env);
  if (config === null) {
    return {
      ok: false,
      reason:
        'No unsubscribe URL can be produced: UNSUBSCRIBE_SECRET must be at least ' +
        `${MIN_SECRET_LENGTH} characters and APP_URL must be an https origin (or ` +
        'http://localhost in development). Refusing to send mail a recipient could not opt ' +
        'out of.',
    };
  }
  const token = unsubscribeToken(identity, config);
  if (token === null) {
    return {
      ok: false,
      reason:
        `Cannot mint an unsubscribe token for contact ${JSON.stringify(identity.contactId)} ` +
        `in organisation ${JSON.stringify(identity.orgId)}. Refusing to send mail a recipient ` +
        'could not opt out of.',
    };
  }
  return { ok: true, url: unsubscribeUrl(token, config) };
}

export interface UnsubscribeHeaders {
  readonly 'List-Unsubscribe': string;
  readonly 'List-Unsubscribe-Post': string;
}

/**
 * The two headers, per RFC 2369 and RFC 8058.
 *
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is what tells the mail provider it may
 * act on this without a round trip through a web page — and, just as importantly, that a bare
 * GET must not be treated as an unsubscribe. Link scanners and prefetchers follow URLs in
 * mail; RFC 8058 exists because senders were unsubscribing people who never clicked anything.
 * The GET route serves a confirmation form, and only the POST changes state.
 *
 * NO `mailto:` VARIANT. It is conventional to offer one, and nothing in this system processes
 * an unsubscribe mailbox. A mailto nobody reads is the same fabricated control as a URL that
 * 404s, so it is absent rather than decorative.
 */
export function listUnsubscribeHeaders(url: string): UnsubscribeHeaders {
  return {
    'List-Unsubscribe': `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

/**
 * The footer offered alongside the header.
 *
 * The header covers clients that implement it — which is most, but not the recipient reading
 * on something that does not. Same URL, because two unsubscribe mechanisms recording different
 * things is a way for them to disagree about whether somebody opted out.
 *
 * The URL is interpolated into an `href`, and it is safe to do so because `usableAppUrl`
 * admits no quote, angle bracket or whitespace, and the token's character class is
 * `[A-Za-z0-9._-]`. That is asserted rather than assumed: `unsubscribe.invariant.test.ts`
 * feeds hostile `APP_URL` values through the whole chain and checks nothing escapes.
 */
export function unsubscribeFooterHtml(url: string): string {
  return (
    `<hr style="margin-top:24px;border:0;border-top:1px solid #e2e8f0">` +
    `<p style="font-size:12px;color:#64748b">` +
    `Don't want these emails? <a href="${url}">Unsubscribe</a>.` +
    `</p>`
  );
}

/** The same thing for a text/plain part. */
export function unsubscribeFooterText(url: string): string {
  return `\n\n---\nTo stop receiving these emails, unsubscribe here: ${url}`;
}
