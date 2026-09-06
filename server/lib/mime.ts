/**
 * S16 / P1.10 — reading an email as an email.
 *
 * WHAT WAS THERE
 * --------------
 *     // Simplistic MIME parser for demonstration
 *     const parseParts = (parts) => {
 *       for (const part of parts) {
 *         if (part.mimeType === 'text/plain' && part.body.data) {
 *           textBody += Buffer.from(part.body.data, 'base64').toString('utf8');
 *         } else if (part.mimeType === 'text/html' && part.body.data) {
 *           htmlBody += Buffer.from(part.body.data, 'base64').toString('utf8');
 *         } else if (part.parts) { parseParts(part.parts); }
 *       }
 *     };
 *
 * Eleven lines, and each of the following is a distinct defect in them:
 *
 *   1. CHARSET IS IGNORED. Every decode is `.toString('utf8')`. `Price: £499` sent as cp1252
 *      arrives as `Price: �499` — the price is destroyed, in the one sentence where being
 *      wrong matters most. Measured, and Node here has full ICU, so the correct decode needs no
 *      dependency.
 *   2. `+=` ON ALTERNATIVES. `multipart/alternative` carries the SAME message twice. Appending
 *      both gives the model the body twice and the customer's words duplicated.
 *   3. IT DESCENDS INTO `message/rfc822`. A forwarded email's text is merged into `textBody`
 *      indistinguishably from what the prospect typed — so anything an attacker can get
 *      forwarded becomes, to every downstream reader, something the prospect said (§18).
 *   4. `part.body.data` IS UNGUARDED. A part with no `body` throws a TypeError that escapes to
 *      the history sync's catch, which mis-tests it against 'historyId is out of date' and
 *      abandons the rest of the page. One malformed part silently drops every message after it.
 *   5. RFC 2047 HEADERS ARE NOT DECODED, so a subject is stored and shown to the model as the
 *      literal `=?UTF-8?B?UsOpOiBwcmljaW5n?=`.
 *   6. `multipart/report` IS SILENTLY DROPPED — a `message/delivery-status` part matches none of
 *      the three branches — while the human-readable preamble IS captured. A bounce therefore
 *      arrives looking exactly like an ordinary reply. That is S28's whole problem, created here.
 *   7. ATTACHMENTS ARE DROPPED WITHOUT RECORD (S17). Not refused, not counted — dropped, so
 *      nothing downstream can even know one existed.
 *   8. NO SIZE CAP and no depth cap.
 *
 * A NOTE ON CONTENT-TRANSFER-ENCODING
 * -----------------------------------
 * This module deliberately does NOT apply `Content-Transfer-Encoding` to Gmail part bodies, and
 * that is a decision rather than an omission. Gmail's `format=full` returns `body.data` already
 * CTE-decoded and base64url re-encoded; the `Content-Transfer-Encoding` header that comes with
 * it describes the ORIGINAL transfer encoding, not the state of the bytes we were handed.
 * Applying quoted-printable to already-decoded text would corrupt any body containing a literal
 * `=` — turning `a=3Db` into `a=b` in a customer's own words. Q-decoding IS applied where it is
 * correct: inside RFC 2047 encoded words, which are never pre-decoded.
 */

// ---------------------------------------------------------------------------
// Limits. Named, so the truncation they cause can be reported rather than silent.
// ---------------------------------------------------------------------------

export const MIME_LIMITS = Object.freeze({
  /** Total decoded characters kept across all text parts of one message. */
  maxTextChars: 200_000,
  /** How deep the part tree may nest before we stop descending. */
  maxDepth: 12,
  /** How many parts we will look at in one message. */
  maxParts: 200,
  /** Attachments recorded in the inventory. Beyond this the count is still reported. */
  maxAttachments: 50,
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

export interface RawHeader {
  name?: unknown;
  value?: unknown;
}

/**
 * Header access that survives the shapes a provider actually sends.
 *
 * `.get` returns the DECODED first value; `.raw` the undecoded one; `.all` every occurrence,
 * because `Received` and `References` legitimately repeat and reading only the first is how a
 * classification misses the signal it was looking for.
 */
export class HeaderBag {
  private readonly entries: Array<{ name: string; value: string }> = [];

  constructor(headers: unknown) {
    if (!Array.isArray(headers)) return;
    for (const h of headers as RawHeader[]) {
      // `h.name.toLowerCase()` threw on any header lacking a name.
      if (h === null || typeof h !== 'object') continue;
      const name = typeof h.name === 'string' ? h.name.toLowerCase() : null;
      if (name === null) continue;
      this.entries.push({ name, value: typeof h.value === 'string' ? h.value : '' });
    }
  }

  raw(name: string): string | null {
    const found = this.entries.find((e) => e.name === name.toLowerCase());
    return found === undefined ? null : found.value;
  }

  get(name: string): string | null {
    const raw = this.raw(name);
    return raw === null ? null : decodeEncodedWords(raw);
  }

  all(name: string): string[] {
    return this.entries.filter((e) => e.name === name.toLowerCase()).map((e) => e.value);
  }

  has(name: string): boolean {
    return this.raw(name) !== null;
  }

  names(): string[] {
    return [...new Set(this.entries.map((e) => e.name))].sort();
  }
}

// ---------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------

/** `text/plain; charset="windows-1252"` -> `windows-1252`. */
export function charsetFromContentType(contentType: string | null | undefined): string | null {
  if (typeof contentType !== 'string') return null;
  const m = /;\s*charset\s*=\s*("([^"]*)"|'([^']*)'|([^;\s]+))/i.exec(contentType);
  if (m === null) return null;
  const value = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  return value === '' ? null : value;
}

export interface DecodedText {
  text: string;
  /** The label actually used. Differs from the requested one when it was not supported. */
  charsetUsed: string;
  /** True when the declared charset could not be honoured and utf-8 was used instead. */
  charsetFallback: boolean;
}

/**
 * Decode bytes with a declared charset.
 *
 * `fatal: false` deliberately: a single bad byte in a long email should produce a replacement
 * character, not throw away the message. The FALLBACK — a charset label the runtime does not
 * know — is reported rather than swallowed, because "we read this as utf-8 and it may be wrong"
 * is exactly the kind of fact that must not be invisible when a price is involved.
 */
export function decodeTextBytes(bytes: Uint8Array, charset: string | null): DecodedText {
  const requested = (charset ?? 'utf-8').trim().toLowerCase();
  try {
    const decoder = new TextDecoder(requested, { fatal: false });
    return { text: decoder.decode(bytes), charsetUsed: requested, charsetFallback: false };
  } catch {
    return {
      text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      charsetUsed: 'utf-8',
      charsetFallback: true,
    };
  }
}

/**
 * Gmail hands us base64url. `Buffer.from(x, 'base64')` happens to accept the base64url alphabet,
 * so the old code worked by accident; naming the encoding makes it work on purpose.
 */
export function decodeBase64UrlBytes(data: unknown): Uint8Array {
  if (typeof data !== 'string' || data === '') return new Uint8Array(0);
  return new Uint8Array(Buffer.from(data, 'base64url'));
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded words
// ---------------------------------------------------------------------------

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

function decodeQBytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '_') {
      out.push(0x20);
    } else if (c === '=' && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else {
        out.push(c.charCodeAt(0));
      }
    } else {
      out.push(c.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * `=?UTF-8?B?UsOpOiBwcmljaW5n?=` -> `Ré: pricing`.
 *
 * Whitespace BETWEEN two adjacent encoded words is removed, per RFC 2047 §6.2 — a single
 * character split across two words would otherwise gain a space in the middle. Whitespace
 * between an encoded word and ordinary text is kept.
 */
export function decodeEncodedWords(value: string): string {
  if (typeof value !== 'string' || !value.includes('=?')) return typeof value === 'string' ? value : '';

  const pieces: Array<{ encoded: boolean; text: string }> = [];
  let last = 0;
  ENCODED_WORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENCODED_WORD.exec(value)) !== null) {
    if (m.index > last) pieces.push({ encoded: false, text: value.slice(last, m.index) });
    const charset = m[1].split('*')[0];
    const bytes = m[2].toUpperCase() === 'B' ? decodeBase64UrlBytes(m[3].replace(/=+$/, '')) : decodeQBytes(m[3]);
    pieces.push({ encoded: true, text: decodeTextBytes(bytes, charset).text });
    last = m.index + m[0].length;
  }
  if (last < value.length) pieces.push({ encoded: false, text: value.slice(last) });

  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const between =
      !p.encoded &&
      p.text.trim() === '' &&
      i > 0 &&
      pieces[i - 1].encoded &&
      i + 1 < pieces.length &&
      pieces[i + 1].encoded;
    if (between) continue;
    out += p.text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML -> text
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£',
  euro: '€', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', trade: '™', deg: '°',
});

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * A TEXT rendering of provider HTML. Never an HTML one.
 *
 * This is deliberately not a sanitizer. A hand-rolled HTML sanitizer that emits HTML is a
 * well-known way to ship an XSS hole; the output here is plain text, so there is no markup left
 * to be dangerous. `script` and `style` CONTENT is dropped rather than flattened, because
 * flattening a script tag turns its source code into what looks like the customer's prose and
 * feeds it to a model (§18).
 *
 * The raw HTML is still kept, under a name that says it is untrusted, so nothing downstream can
 * mistake it for something that has been made safe.
 */
export function htmlToText(html: string): string {
  if (typeof html !== 'string' || html === '') return '';
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  // An unclosed <script> would otherwise leave its body as text.
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*$/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// ---------------------------------------------------------------------------
// The part walk
// ---------------------------------------------------------------------------

export interface AttachmentRecord {
  filename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  attachmentId: string | null;
}

export interface ParsedBody {
  textBody: string;
  /** Raw provider HTML. Untrusted. Never rendered, never called sanitized. */
  untrustedHtmlBody: string;
  /** The text rendering of the HTML, used when there is no text/plain alternative. */
  htmlAsText: string;
  /** Every `message/delivery-status` field set found, for S28. Empty for ordinary mail. */
  deliveryStatus: Array<Record<string, string>>;
  /** Attachments are recorded, not silently dropped (S17). */
  attachments: AttachmentRecord[];
  attachmentCount: number;
  /** True when a `message/rfc822` part was present and deliberately NOT inlined. */
  hasEmbeddedMessage: boolean;
  /** Charsets we could not honour. Non-empty means some text may be misread. */
  charsetFallbacks: string[];
  truncated: boolean;
  partsSeen: number;
}

function contentTypeOf(part: any, headers: HeaderBag): string {
  const declared = typeof part?.mimeType === 'string' ? part.mimeType : null;
  if (declared !== null && declared !== '') return declared.toLowerCase();
  const ct = headers.raw('content-type');
  if (ct === null) return 'application/octet-stream';
  return ct.split(';')[0].trim().toLowerCase();
}

function isAttachment(part: any, headers: HeaderBag): boolean {
  const disposition = headers.raw('content-disposition') ?? '';
  if (/^\s*attachment/i.test(disposition)) return true;
  return typeof part?.filename === 'string' && part.filename !== '';
}

/**
 * Walk a Gmail `format=full` payload.
 *
 * Never throws. A malformed part is skipped and counted; the previous version's unguarded
 * `part.body.data` took the whole history page down with it.
 */
export function walkGmailPayload(payload: unknown, limits = MIME_LIMITS): ParsedBody {
  const out: ParsedBody = {
    textBody: '',
    untrustedHtmlBody: '',
    htmlAsText: '',
    deliveryStatus: [],
    attachments: [],
    attachmentCount: 0,
    hasEmbeddedMessage: false,
    charsetFallbacks: [],
    truncated: false,
    partsSeen: 0,
  };

  const textChunks: string[] = [];
  const htmlChunks: string[] = [];
  let charsBudget: number = limits.maxTextChars;

  const takeText = (chunk: string): string => {
    if (charsBudget <= 0) {
      out.truncated = true;
      return '';
    }
    if (chunk.length > charsBudget) {
      out.truncated = true;
      const kept = chunk.slice(0, charsBudget);
      charsBudget = 0;
      return kept;
    }
    charsBudget -= chunk.length;
    return chunk;
  };

  const decodePart = (part: any, headers: HeaderBag): string => {
    const bytes = decodeBase64UrlBytes(part?.body?.data);
    if (bytes.length === 0) return '';
    const charset = charsetFromContentType(headers.raw('content-type'));
    const decoded = decodeTextBytes(bytes, charset);
    if (decoded.charsetFallback && charset !== null && !out.charsetFallbacks.includes(charset)) {
      out.charsetFallbacks.push(charset);
    }
    return decoded.text;
  };

  const visit = (part: any, depth: number): void => {
    if (part === null || typeof part !== 'object') return;
    if (depth > limits.maxDepth) return;
    if (out.partsSeen >= limits.maxParts) {
      out.truncated = true;
      return;
    }
    out.partsSeen++;

    const headers = new HeaderBag(part.headers);
    const type = contentTypeOf(part, headers);

    // An attachment is recorded, never inlined. It used to be dropped so completely that
    // nothing downstream could know it had existed.
    if (isAttachment(part, headers)) {
      out.attachmentCount++;
      if (out.attachments.length < limits.maxAttachments) {
        out.attachments.push({
          filename: typeof part.filename === 'string' && part.filename !== '' ? part.filename : null,
          mimeType: type,
          sizeBytes: typeof part?.body?.size === 'number' ? part.body.size : null,
          attachmentId: typeof part?.body?.attachmentId === 'string' ? part.body.attachmentId : null,
        });
      }
      return;
    }

    // A forwarded message is NOT the prospect's words. The old walk recursed into anything
    // with `.parts`, so an attacker's forwarded text became indistinguishable from what the
    // person actually typed — untrusted content acquiring the authority of the sender (§18).
    if (type === 'message/rfc822') {
      out.hasEmbeddedMessage = true;
      return;
    }

    if (type === 'message/delivery-status') {
      // The part that made a bounce look like a reply, because it matched none of the three
      // old branches and was dropped while the human-readable preamble was kept.
      const text = decodePart(part, headers);
      for (const block of text.split(/\n\s*\n/)) {
        const fields: Record<string, string> = {};
        for (const line of block.split(/\r?\n/)) {
          const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line.trim());
          if (m !== null) fields[m[1].toLowerCase()] = m[2].trim();
        }
        if (Object.keys(fields).length > 0) out.deliveryStatus.push(fields);
      }
      return;
    }

    const children = Array.isArray(part.parts) ? part.parts : null;

    if (type === 'multipart/alternative' && children !== null) {
      // The SAME message in several forms. Appending them all gives the model the body twice.
      // The last alternative of each type is the richest, per RFC 2046 §5.1.4.
      let chosenText: any = null;
      let chosenHtml: any = null;
      for (const child of children) {
        const childType = contentTypeOf(child, new HeaderBag(child?.headers));
        if (childType === 'text/plain') chosenText = child;
        else if (childType === 'text/html') chosenHtml = child;
      }
      if (chosenText === null && chosenHtml === null) {
        for (const child of children) visit(child, depth + 1);
        return;
      }
      if (chosenText !== null) visit(chosenText, depth + 1);
      if (chosenHtml !== null) visit(chosenHtml, depth + 1);
      return;
    }

    if (children !== null) {
      for (const child of children) visit(child, depth + 1);
      return;
    }

    if (type === 'text/plain') {
      textChunks.push(takeText(decodePart(part, headers)));
      return;
    }
    if (type === 'text/html') {
      htmlChunks.push(takeText(decodePart(part, headers)));
      return;
    }
    // Anything else with no children and no disposition: counted, not inlined.
  };

  visit(payload, 0);

  out.textBody = textChunks.join('\n').trim();
  out.untrustedHtmlBody = htmlChunks.join('\n');
  out.htmlAsText = htmlToText(out.untrustedHtmlBody);
  return out;
}
