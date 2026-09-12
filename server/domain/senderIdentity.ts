/**
 * S27 — sender identity health, evaluated from DNS records: SPF, DKIM, DMARC.
 *
 * WHAT WAS MISSING
 * ----------------
 * Nothing asked whether the domain this system sends from is set up to be believed. A domain
 * with no SPF record, or a DMARC policy the receiver cannot align, delivers to spam folders — or
 * not at all — and every figure downstream (replies, meetings) is then measured against mail
 * nobody saw. "Deliverability is unmeasured rather than misreported" was the honest state; this
 * is the measurement.
 *
 * This module is PURE: it takes the DNS answers and returns a verdict. The resolver lives in
 * server/services/deliverability.service.ts, so every rule here is tested on real record shapes
 * without a network, and the network is one thin adapter.
 *
 * WHAT IS NOT INVENTED
 * --------------------
 * A lookup that FAILED (timeout, SERVFAIL) is UNKNOWN, never MISSING: "we could not ask" and "the
 * record is not there" are different facts, and only the second is the operator's to fix. A
 * verdict of UNKNOWN is treated as a refusal by the gate (§14), for the same reason the kill
 * switch treats an unreadable state as paused. Two SPF records is INVALID (RFC 7208 §3.2, a
 * permanent error at every receiver), not "present twice".
 */

export type DnsAnswer = { readonly ok: true; readonly records: readonly string[] } | { readonly ok: false; readonly error: string };

export interface SenderRecords {
  readonly domain: string;
  /** TXT at `<domain>`. */
  readonly spf: DnsAnswer;
  /** TXT at `_dmarc.<domain>`. */
  readonly dmarc: DnsAnswer;
  /** TXT at `<selector>._domainkey.<domain>`, one per selector tried. */
  readonly dkim: readonly { readonly selector: string; readonly answer: DnsAnswer }[];
}

export type RecordState = 'PRESENT' | 'MISSING' | 'INVALID' | 'UNKNOWN';

export interface MechanismVerdict {
  readonly state: RecordState;
  /** SPF: the `all` qualifier; DMARC: `p=`; DKIM: the selector that answered. */
  readonly policy: string | null;
  readonly detail: string;
}

export type PostureVerdict = 'READY' | 'WEAK' | 'MISSING' | 'UNKNOWN';

export interface SenderPosture {
  readonly domain: string;
  readonly spf: MechanismVerdict;
  readonly dkim: MechanismVerdict;
  readonly dmarc: MechanismVerdict;
  readonly verdict: PostureVerdict;
  readonly reasons: readonly string[];
}

/** TXT records arrive as chunks; a record is the chunks joined. Case-insensitive tag matching. */
const normalise = (record: string) => record.trim();

function evaluateSpf(answer: DnsAnswer): MechanismVerdict {
  if (!answer.ok) return { state: 'UNKNOWN', policy: null, detail: `SPF lookup failed: ${answer.error}` };
  const records = answer.records.map(normalise).filter((r) => /^v=spf1(\s|$)/i.test(r));
  if (records.length === 0) return { state: 'MISSING', policy: null, detail: 'no TXT record beginning v=spf1' };
  if (records.length > 1) {
    return { state: 'INVALID', policy: null, detail: `${records.length} SPF records; RFC 7208 §3.2 makes that a permanent error at every receiver` };
  }
  const record = records[0];
  const all = /(?:^|\s)([-~?+]?)all(?:\s|$)/i.exec(record);
  // `redirect=` hands the whole evaluation to another domain's record (RFC 7208 §6.1), so the
  // absence of `all` here says nothing — gmail.com itself is `v=spf1 redirect=_spf.google.com`.
  // Found by evaluating real records: the first version called that weak.
  const redirect = /(?:^|\s)redirect=([^\s]+)/i.exec(record);
  if (!all && redirect) return { state: 'PRESENT', policy: 'redirect', detail: `${record} — policy is ${redirect[1]}'s` };
  if (!all) return { state: 'PRESENT', policy: 'no-all', detail: `${record} — no "all" mechanism, so unlisted senders are neutral by default` };
  const qualifier = all[1] === '' ? '+' : all[1];
  const policy = { '-': 'fail', '~': 'softfail', '?': 'neutral', '+': 'pass' }[qualifier] ?? qualifier;
  return { state: 'PRESENT', policy, detail: record };
}

function evaluateDmarc(answer: DnsAnswer): MechanismVerdict {
  if (!answer.ok) return { state: 'UNKNOWN', policy: null, detail: `DMARC lookup failed: ${answer.error}` };
  const records = answer.records.map(normalise).filter((r) => /^v=DMARC1\s*;/i.test(r));
  if (records.length === 0) return { state: 'MISSING', policy: null, detail: 'no TXT record at _dmarc beginning v=DMARC1' };
  if (records.length > 1) return { state: 'INVALID', policy: null, detail: `${records.length} DMARC records; receivers treat that as none` };
  const record = records[0];
  const p = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i.exec(record);
  if (!p) return { state: 'INVALID', policy: null, detail: `${record} — no p= policy, which receivers treat as no DMARC` };
  const rua = /(?:^|;)\s*rua\s*=/i.test(record);
  return {
    state: 'PRESENT',
    policy: p[1].toLowerCase(),
    detail: `${record}${rua ? '' : ' — no rua=, so nobody receives aggregate reports'}`,
  };
}

function evaluateDkim(answers: SenderRecords['dkim']): MechanismVerdict {
  if (answers.length === 0) return { state: 'MISSING', policy: null, detail: 'no DKIM selector configured to check' };
  let sawUnknown: string | null = null;
  for (const { selector, answer } of answers) {
    if (!answer.ok) {
      sawUnknown = `${selector}: ${answer.error}`;
      continue;
    }
    const records = answer.records.map(normalise).filter((r) => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(r));
    if (records.length === 0) continue;
    const record = records[0];
    const p = /(?:^|;)\s*p\s*=\s*([^;\s]*)/i.exec(record);
    if (p && p[1] === '') return { state: 'INVALID', policy: selector, detail: `${selector}._domainkey has an empty p=, which revokes the key` };
    return { state: 'PRESENT', policy: selector, detail: `${selector}._domainkey publishes a key` };
  }
  if (sawUnknown) return { state: 'UNKNOWN', policy: null, detail: `DKIM lookup failed: ${sawUnknown}` };
  return { state: 'MISSING', policy: null, detail: `no key at ${answers.map((a) => a.selector).join(', ')}._domainkey` };
}

/**
 * The verdict, and why.
 *
 *   UNKNOWN  SPF or DMARC could not be looked up. Not judged; the gate refuses.
 *   MISSING  SPF or DMARC is absent or invalid. Receivers cannot authenticate the mail; the gate refuses.
 *   WEAK     Everything needed is present, but DMARC is p=none, or SPF ends +all, or no DKIM key was
 *            found at the configured selectors (Google signs with its own domain then, and DMARC
 *            alignment rests on SPF alone). Sending proceeds; the operator is told.
 *   READY    SPF present with a restrictive `all`, DMARC present with p=quarantine|reject, DKIM key found.
 */
export function evaluateSenderRecords(records: SenderRecords): SenderPosture {
  const spf = evaluateSpf(records.spf);
  const dmarc = evaluateDmarc(records.dmarc);
  const dkim = evaluateDkim(records.dkim);
  const reasons: string[] = [];

  let verdict: PostureVerdict = 'READY';
  if (spf.state === 'UNKNOWN' || dmarc.state === 'UNKNOWN') {
    verdict = 'UNKNOWN';
    if (spf.state === 'UNKNOWN') reasons.push(spf.detail);
    if (dmarc.state === 'UNKNOWN') reasons.push(dmarc.detail);
  } else if (spf.state !== 'PRESENT' || dmarc.state !== 'PRESENT') {
    verdict = 'MISSING';
    if (spf.state !== 'PRESENT') reasons.push(`SPF ${spf.state}: ${spf.detail}`);
    if (dmarc.state !== 'PRESENT') reasons.push(`DMARC ${dmarc.state}: ${dmarc.detail}`);
  } else {
    if (dmarc.policy === 'none') reasons.push('DMARC p=none: receivers report but do not act, so a spoofed message is delivered like a real one');
    if (spf.policy === 'pass') reasons.push('SPF ends +all: it authorises every sender on the internet, which is no authorisation');
    if (spf.policy === 'no-all') reasons.push('SPF has no "all" mechanism, so it says nothing about unlisted senders');
    if (dkim.state !== 'PRESENT') reasons.push(`DKIM ${dkim.state}: ${dkim.detail}`);
    if (reasons.length > 0) verdict = 'WEAK';
  }

  return { domain: records.domain, spf, dkim, dmarc, verdict, reasons };
}

/** Whether the gate lets an autonomous send proceed under this posture (§14: unknown is not permission). */
export function posturePermitsSending(posture: SenderPosture): boolean {
  return posture.verdict === 'READY' || posture.verdict === 'WEAK';
}

/** The domain of an address, lowercased, or null if the address has none. */
export function domainOfAddress(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  // No local part, or no domain part, is not an address.
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().replace(/>$/, '').toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) ? domain : null;
}
