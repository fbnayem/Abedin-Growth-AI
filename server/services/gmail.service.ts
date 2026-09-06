import { config } from '../config/environment';
import { fetchWithTimeout } from '../lib/httpClient';
import { classifyResponse, classifyThrown, ProviderError } from '../lib/providerError';
import type { EmailProvider, RefreshableCredential } from '../providers/types';
import type { SentMessageLookup } from '../lib/reconciliation';
import { bareMessageId, headerLine, isWellFormedMessageId } from '../lib/messageIdentity';
import { HeaderBag, walkGmailPayload, type ParsedBody } from '../lib/mime';
import type { Capability } from '../lib/capabilities';

export interface SendEmailOptions {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
  /**
   * S32 — the RFC 5322 Message-ID to stamp on this message, derived deterministically from the
   * job's idempotency key by the caller. It is what makes the send reconcilable: after an
   * ambiguous outcome, `rfc822msgid:<this>` is an exact provider-side search for "did this
   * specific send happen". Optional in the type only so the demo path can run; the gateway
   * requires it.
   */
  rfc822MessageId?: string;
}

/**
 * S19 — a Gmail history id is an unsigned 64-bit decimal. Twenty digits covers the whole range,
 * and a leading zero is not a form Google issues.
 */
export function isValidHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: any;
  // mapped fields
  subject: string;
  from: string;
  to: string;
  date: string;
  textBody: string;
  /**
   * S16/S35 — renamed from `htmlBody`, and stored under a name that says what it is.
   *
   * This is provider HTML exactly as it arrived. It has not been sanitized, it must never be
   * rendered, and the column it lands in used to be called `sanitizedHtmlBody` — a name that
   * asserted a property nothing in the repository provided. Use `htmlAsText` for anything that
   * reads the content.
   */
  untrustedHtmlBody: string;
  /** A TEXT rendering of the HTML. Safe to show, safe to give to a model. */
  htmlAsText: string;
  inReplyTo?: string;
  references?: string;
  /** S15 — the RFC 5322 Message-ID. The column existed; nothing wrote it. */
  messageIdHeader: string | null;
  /** Every header, for classification. `payload.headers` was carried and never read. */
  headers: HeaderBag;
  /** The structural result of the MIME walk: DSN parts, attachments, truncation. */
  parsed: ParsedBody;
}

// P1.11 — the adapter now states its contract instead of merely happening to satisfy one.
// `implements` makes the compiler check it: an adapter that stops throwing ProviderError, or
// starts inventing message ids, fails the build rather than the production send.
export class GmailService implements EmailProvider, RefreshableCredential, SentMessageLookup {
  readonly providerName = 'gmail';
  readonly requiredCapabilities: readonly Capability[] = ['EMAIL_SEND'];

  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    // initialize from DB or secure vault
  }

  setCredentials(tokens: { access_token: string; refresh_token?: string }) {
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }
  }

  /**
   * P1.11 — the refresh flow.
   *
   * `refreshToken` was a private field that was written and never read: there was no refresh
   * flow at all, and no refresh token was even persisted (the `oauth_connections` record
   * stored `accessToken` and `expiresAt` only). A Google access token lasts an hour, so every
   * connection failed with a 401 after an hour and stayed failed until a human reconnected.
   *
   * A 401 is `NOT_APPLIED` and retryable exactly once the credential is replaced — which is
   * why the disposition table marks it retryable while `PERMISSION_DENIED` is not: one is
   * fixable by us, the other needs a person to consent.
   */
  async refreshAccessToken(): Promise<{ accessToken: string; expiresAt: Date | null }> {
    if (!this.refreshToken) {
      throw new ProviderError({
        provider: "gmail",
        operation: "refreshAccessToken",
        kind: "PERMISSION_DENIED",
        signal: "no refresh token stored",
      });
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      // Refusing loudly rather than attempting a call that cannot succeed: a request with no
      // client credentials returns 400, which would classify as INVALID_REQUEST and read as
      // "our payload is malformed" rather than "this deployment is not configured".
      throw new ProviderError({
        provider: "gmail",
        operation: "refreshAccessToken",
        kind: "PERMISSION_DENIED",
        signal: "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured",
      });
    }

    let res: Response;
    try {
      res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.refreshToken,
          grant_type: "refresh_token",
        }).toString(),
      });
    } catch (e) {
      throw classifyThrown(e, { provider: "gmail", operation: "refreshAccessToken" });
    }

    if (!res.ok) {
      // Refreshing is idempotent and has no external side effect, so an ambiguous outcome
      // here is safe to retry — unlike a send.
      throw classifyResponse(res, { provider: "gmail", operation: "refreshAccessToken" });
    }

    const data: any = await res.json();
    if (typeof data?.access_token !== "string" || data.access_token.length === 0) {
      throw new ProviderError({
        provider: "gmail",
        operation: "refreshAccessToken",
        kind: "UNKNOWN",
        signal: "200 response carried no access_token",
      });
    }
    this.accessToken = data.access_token;
    const expiresAt =
      typeof data.expires_in === "number"
        ? new Date(Date.now() + data.expires_in * 1000)
        : null; // absent means unknown, never "forever"
    return { accessToken: data.access_token, expiresAt };
  }

  
  async getHistory(historyId: string, emailAddress: string): Promise<any[]> {
    if (!this.accessToken) throw new Error("Credentials not set");

    // S19 — `historyId` arrives from `/api/webhooks/gmail`, which is unauthenticated and
    // signature-unverified, and it used to be interpolated straight into this URL. A value
    // like `1&labelId=x` or `1#` reshapes the request we make on the customer's mailbox.
    //
    // Validated rather than merely encoded, because a Gmail history id is an unsigned decimal
    // and nothing else: percent-encoding a value that could never be legitimate turns an
    // injection into a confusing 400 instead of a refusal. `isValidHistoryId` says what the
    // value must BE, which is the stronger statement.
    if (!isValidHistoryId(historyId)) {
      throw new ProviderError({
        provider: 'gmail',
        operation: 'getHistory',
        kind: 'INVALID_REQUEST',
        signal: 'startHistoryId is not an unsigned decimal id; refusing to build a request from it',
      });
    }

    // The encode is MEASURABLY REDUNDANT given the validator above, and it stays anyway.
    //
    // Removing it survived mutation testing, correctly: across 299,999 ids matching
    // `^[1-9]\d{0,19}$` — every 1-to-5-digit value exhaustively plus 200,000 random longer ones
    // — `encodeURIComponent` changed the value 0 times. No test can distinguish the two
    // versions, and writing one that appeared to would be writing a test that asserts nothing.
    //
    // It is kept as the second half of a pair: if the validator is ever loosened, this is what
    // still turns `1&labelId=x` into `1%26labelId%3Dx` instead of a second query parameter on a
    // request against a customer's mailbox. Recorded here so the next person to see an
    // "unnecessary" call knows it was measured rather than left in by accident.
    const res = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(historyId)}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    
    if (!res.ok) {
       // P1.11 — this returned `[]`, which reads to every caller as "no new messages".
       // A dead credential (401) and a quiet inbox became the same value, so a broken
       // connection looked like a working one with nothing to do. Silence is not emptiness.
       throw classifyResponse(res, { provider: "gmail", operation: "getHistory" });
    }
    const data = await res.json();
    return data.history || [];
  }

  async getMessage(messageId: string): Promise<GmailMessage | null> {
    if (!this.accessToken) throw new Error("Credentials not set");
    
    const res = await fetchWithTimeout(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    
    if (!res.ok) {
       // Same defect as getHistory: `null` meant both "no such message" and "we could not
       // ask". A 404 genuinely is absence; a 401 or a 503 is not.
       if (res.status === 404) return null;
       throw classifyResponse(res, { provider: "gmail", operation: "getMessage" });
    }
    const data = await res.json();
    return this.parseMessage(data);
  }

  /**
   * S16 — the MIME walk moved to `lib/mime.ts`, where it can be tested against the shapes
   * Google actually sends. What was here was eleven lines that ignored charset, appended both
   * halves of a `multipart/alternative`, recursed into `message/rfc822` so a forwarded email's
   * text became the prospect's own words, dereferenced `part.body.data` without a guard, left
   * RFC 2047 subjects as `=?UTF-8?B?...?=`, and dropped the `message/delivery-status` part of a
   * bounce while keeping its human-readable preamble — which is how a delivery failure came to
   * look exactly like a reply.
   */
  private parseMessage(data: any): GmailMessage {
    const headers = new HeaderBag(data?.payload?.headers);
    const parsed = walkGmailPayload(data?.payload);

    return {
      id: typeof data?.id === 'string' ? data.id : '',
      threadId: typeof data?.threadId === 'string' ? data.threadId : '',
      snippet: typeof data?.snippet === 'string' ? data.snippet : '',
      payload: data?.payload,
      // `.get` decodes RFC 2047 encoded words; `.raw` does not. Anything a human or a model
      // will read goes through `.get`.
      subject: headers.get('subject') ?? '',
      from: headers.get('from') ?? '',
      to: headers.get('to') ?? '',
      date: headers.raw('date') ?? '',
      textBody: parsed.textBody,
      untrustedHtmlBody: parsed.untrustedHtmlBody,
      htmlAsText: parsed.htmlAsText,
      // A Message-ID is a structural identifier, not display text: it must not be
      // encoded-word-decoded, or a hostile display name could reshape it.
      inReplyTo: headers.raw('in-reply-to') ?? '',
      references: headers.raw('references') ?? '',
      messageIdHeader: headers.raw('message-id'),
      headers,
      parsed,
    };
  }

  /**
   * S32 — the question reconciliation asks.
   *
   * `rfc822msgid:` is Gmail's exact-match operator on the RFC 5322 Message-ID, which is why
   * the send stamps a deterministic one. `in:sent` scopes it to mail this mailbox actually
   * transmitted: a message with the same id sitting in the inbox would be a copy we RECEIVED,
   * and reading that as proof we sent it is how a reconciliation mistakes a bounce for a
   * delivery.
   *
   * Absence is returned as `null` and failure is thrown, never the other way round. The two
   * are different answers to the §32 question and `reconcileEmailSend` treats them completely
   * differently — one can license a retry, the other never may.
   */
  async findSentMessageByRfc822MessageId(
    rfc822MessageId: string
  ): Promise<{ id: string; threadId: string } | null> {
    if (!this.accessToken) {
      throw new ProviderError({
        provider: 'gmail',
        operation: 'findSentMessageByRfc822MessageId',
        kind: 'PERMISSION_DENIED',
        signal: 'no access token set',
      });
    }
    if (!isWellFormedMessageId(rfc822MessageId)) {
      throw new ProviderError({
        provider: 'gmail',
        operation: 'findSentMessageByRfc822MessageId',
        kind: 'INVALID_REQUEST',
        signal: 'malformed Message-ID; refusing to build a provider query from it',
      });
    }

    const q = encodeURIComponent(`in:sent rfc822msgid:${bareMessageId(rfc822MessageId)}`);
    let res: Response;
    try {
      res = await fetchWithTimeout(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=2&q=${q}`,
        { headers: { Authorization: `Bearer ${this.accessToken}` } }
      );
    } catch (e) {
      throw classifyThrown(e, { provider: 'gmail', operation: 'findSentMessageByRfc822MessageId' });
    }

    if (!res.ok) {
      throw classifyResponse(res, { provider: 'gmail', operation: 'findSentMessageByRfc822MessageId' });
    }

    const data: any = await res.json();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    if (messages.length === 0) return null;

    const first = messages[0];
    if (typeof first?.id !== 'string' || first.id === '') {
      // A 200 whose body does not carry an id has not answered the question. Throwing keeps
      // this in the STILL_UNKNOWN column rather than letting it read as a confirmed send.
      throw new ProviderError({
        provider: 'gmail',
        operation: 'findSentMessageByRfc822MessageId',
        kind: 'UNKNOWN',
        signal: 'search matched but the result carried no message id',
      });
    }
    return { id: first.id, threadId: typeof first.threadId === 'string' ? first.threadId : '' };
  }

  async sendEmail(opts: SendEmailOptions): Promise<{ messageId: string, threadId: string }> {
    if (config.demoMode) {
      // P0.8 — This simulation is retained for local development, but its output is
      // deliberately shaped so it CANNOT be laundered into a durable SENT record. The
      // `sim_` prefix is matched by isFabricatedProviderId() in the ActionGateway, and
      // outbox.worker.ts fails any job whose provider id matches it. If you change this
      // prefix, change that guard too — otherwise simulated sends silently become "sent".
      console.warn(
        `[DEMO MODE] Simulating Gmail send to ${opts.to}. This produces a fabricated ` +
        `provider id which downstream code MUST reject; it can never be recorded as SENT.`
      );
      return {
        messageId: `sim_${Date.now()}_msg`,
        threadId: opts.threadId || `sim_${Date.now()}_thread`
      };
    }
    
    if (!this.accessToken) {
      throw new Error("Gmail credentials not configured");
    }

    // S16 — every header value is now checked before it becomes a header.
    //
    // This was raw interpolation: `Subject: ${opts.subject}`. The reply subject is derived
    // from the INBOUND subject, so a customer who puts a CR-LF in theirs ended that header and
    // made the remainder into headers of their own — `Bcc:` among them. Data became structure,
    // which is the §18 failure in its most literal form. `headerLine` throws rather than
    // stripping: silently deleting part of a subject changes what the recipient sees with no
    // record, and a subject with a bare CR in it is an attack or a bug, never a typo.
    //
    // S32 — the Message-ID is stamped here. Deterministic, derived from the job's idempotency
    // key, so the SAME send produces the SAME id on every attempt in every process. That is
    // what `reconcileEmailSend` searches for afterwards. Without it a timed-out send could
    // never be asked about, which is why §32 reconciliation stayed a comment for so long.
    const messageParts = [
      headerLine('To', opts.to),
      headerLine('Subject', opts.subject),
      'Content-Type: text/html; charset=utf-8',
    ];
    if (opts.rfc822MessageId) {
      messageParts.push(headerLine('Message-ID', opts.rfc822MessageId));
    }
    if (opts.inReplyTo) messageParts.push(headerLine('In-Reply-To', opts.inReplyTo));
    if (opts.references) messageParts.push(headerLine('References', opts.references));
    messageParts.push('', opts.bodyHtml || opts.bodyText || '');

    const rawMessage = Buffer.from(messageParts.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetchWithTimeout('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: rawMessage,
        threadId: opts.threadId
      })
    });

    if (!res.ok) {
      // P1.11 — this threw a bare Error with the status embedded in prose, which is what the
      // gateway then tried to classify by substring. The status is now carried structurally,
      // and the provider's own text is logged rather than put in the message: it quotes
      // request content, and request content is untrusted (§18).
      console.error("Gmail API Error:", await res.text());
      throw classifyResponse(res, { provider: "gmail", operation: "sendEmail" });
    }

    const data = await res.json();
    return {
      messageId: data.id,
      threadId: data.threadId
    };
  }
}

export const gmailService = new GmailService();
