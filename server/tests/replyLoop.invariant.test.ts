import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  replyLoopVerdict,
  MAX_REPLIES_PER_WINDOW,
  WINDOW_MS,
  MIN_INTERVAL_MS,
} from '../domain/replyLoop';
import { classifyAutomation, mayReplyTo } from '../domain/automatedMail';
import { HeaderBag, type ParsedBody } from '../lib/mime';

/**
 * INVARIANTS FOR THE REPLY-LOOP BUDGET (addendum S28).
 *
 * `classifyAutomation` refuses to answer anything carrying an automation marker, and
 * deliberately never reads subject prose — matching "Out of Office" is the substring
 * classification this repository already has a guardrail against, and it fails the moment an
 * autoresponder writes in another language.
 *
 * That leaves the remainder the status document names: an out-of-office setting no
 * `Auto-Submitted`, no `X-Autoreply` and no `Precedence`, from a personal address, is
 * indistinguishable from a person. No header can be added, because the evidence is not in the
 * message.
 *
 * RFC 3834 §2.1 answers this with a rate limit rather than a better classifier. Two machines
 * answering each other is the harm; a counter stops it whatever the messages looked like.
 */

const NOW = 1_800_000_000_000;
const ago = (ms: number) => NOW - ms;

describe('1. an unreadable history refuses, and that is the whole point', () => {
  /**
   * `outbox.service.listByStatus` catches its own errors and returns `[]`. That is right for
   * drawing the operator console — a queue it cannot read displays as empty — and would be an
   * inversion here: a failed query would become "no replies sent yet" and the loop check would
   * permit the send it exists to stop.
   *
   * Three of the autonomy lock's original defects were exactly this shape, which is why the
   * history is `number[] | null` rather than `number[]`.
   */
  it('null history refuses', () => {
    const verdict = replyLoopVerdict({ history: null, now: NOW });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('HISTORY_UNAVAILABLE');
  });

  it('an EMPTY history permits — it is a different fact from an unreadable one', () => {
    // Without this the module would be a function that always refuses, which passes every
    // assertion above and stops the product working.
    const verdict = replyLoopVerdict({ history: [], now: NOW });
    expect(verdict.allowed).toBe(true);
    expect(verdict.allowed && verdict.repliesInWindow).toBe(0);
  });

  it('a history containing something that is not a timestamp refuses', () => {
    // Dropping the bad entry shrinks the count, and a shorter count permits. Treating it as
    // recent refuses everything. Neither is honest about what is known.
    for (const bad of [NaN, Infinity, -Infinity, '123', null, undefined, {}]) {
      const verdict = replyLoopVerdict({
        history: [ago(WINDOW_MS * 2), bad] as unknown as number[],
        now: NOW,
      });
      expect(verdict.allowed, `accepted ${String(bad)}`).toBe(false);
      expect(verdict.allowed === false && verdict.code).toBe('HISTORY_UNAVAILABLE');
    }
  });
});

describe('2. the cadence limit stops a fast loop', () => {
  it('refuses a reply inside the minimum interval', () => {
    const verdict = replyLoopVerdict({ history: [ago(30_000)], now: NOW });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('TOO_SOON');
  });

  it('permits once the interval has passed', () => {
    expect(replyLoopVerdict({ history: [ago(MIN_INTERVAL_MS + 1)], now: NOW }).allowed).toBe(true);
  });

  it('the boundary is exact and closed', () => {
    // Exactly at the interval is permitted; one millisecond short is not. Stated so that a
    // `<=` slipped in here changes a test rather than only a comment.
    expect(replyLoopVerdict({ history: [ago(MIN_INTERVAL_MS)], now: NOW }).allowed).toBe(true);
    expect(replyLoopVerdict({ history: [ago(MIN_INTERVAL_MS - 1)], now: NOW }).allowed).toBe(false);
  });

  it('the MOST RECENT send decides, not the first', () => {
    // A conversation with an old reply and a very recent one must be refused. Reading
    // `history[0]` rather than the maximum would permit it, and a queue is not ordered by time.
    const verdict = replyLoopVerdict({ history: [ago(WINDOW_MS - 1), ago(5_000)], now: NOW });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('TOO_SOON');
  });
});

describe('3. the window limit stops a slow one', () => {
  const spaced = (n: number) =>
    Array.from({ length: n }, (_, i) => ago(MIN_INTERVAL_MS * 2 * (i + 1)));

  it('permits up to the limit', () => {
    const verdict = replyLoopVerdict({ history: spaced(MAX_REPLIES_PER_WINDOW - 1), now: NOW });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses at the limit', () => {
    // An autoresponder answering hourly clears the minimum interval every time and is caught
    // only here. Neither limit substitutes for the other.
    const verdict = replyLoopVerdict({ history: spaced(MAX_REPLIES_PER_WINDOW), now: NOW });
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.code).toBe('WINDOW_EXHAUSTED');
  });

  it('only counts replies inside the window', () => {
    // Otherwise the limit is a lifetime cap and every long-running conversation eventually
    // stops working, which is how a safety limit gets raised until it does nothing.
    const old = Array.from({ length: 20 }, (_, i) => ago(WINDOW_MS + 1000 * (i + 1)));
    expect(replyLoopVerdict({ history: old, now: NOW }).allowed).toBe(true);
  });

  it('the window boundary is exact', () => {
    const atEdge = Array(MAX_REPLIES_PER_WINDOW).fill(ago(WINDOW_MS));
    // Exactly WINDOW_MS old is OUTSIDE the window (`now - t < WINDOW_MS`), so these do not count.
    expect(replyLoopVerdict({ history: atEdge, now: NOW }).allowed).toBe(true);
    const justInside = Array(MAX_REPLIES_PER_WINDOW).fill(ago(WINDOW_MS - 1));
    expect(replyLoopVerdict({ history: justInside, now: NOW }).allowed).toBe(false);
  });

  it('a future-stamped send is counted, not discarded', () => {
    // A clock problem is not permission. If the row is real it is a reply we made, and
    // discarding it would let a skewed clock buy extra turns.
    const future = Array(MAX_REPLIES_PER_WINDOW).fill(NOW + 60_000);
    expect(replyLoopVerdict({ history: future, now: NOW }).allowed).toBe(false);
  });
});

describe('4. the classifier still refuses what it can see, and now sees three more things', () => {
  const bag = (headers: Record<string, string>) =>
    new HeaderBag(Object.entries(headers).map(([name, value]) => ({ name, value })));
  const emptyBody: ParsedBody = {
    text: '',
    html: '',
    deliveryStatus: [],
    attachments: [],
    truncated: false,
  } as unknown as ParsedBody;

  const classOf = (headers: Record<string, string>) =>
    classifyAutomation({ headers: bag(headers), body: emptyBody }).classification;

  it('a read receipt is not answered', () => {
    // An MDN is `multipart/report` with `report-type=disposition-notification`. It is not a
    // bounce, so it never reached the DSN branch: `deliveryStatus` is empty and the report-type
    // does not match. It fell through every branch and was answered as a reply.
    expect(
      classOf({ 'content-type': 'multipart/report; report-type=disposition-notification; boundary=x' })
    ).toBe('AUTO_GENERATED');
  });

  it('a loop-prevention header is honoured', () => {
    expect(classOf({ 'x-loop': 'autoresponder@example.com' })).toBe('AUTO_GENERATED');
  });

  it('a request not to auto-respond is honoured', () => {
    expect(classOf({ 'x-auto-response-suppress': 'OOF, AutoReply' })).toBe('AUTO_GENERATED');
  });

  it('an ordinary message is still answerable', () => {
    // The other half. A classifier that refused everything would satisfy every assertion above
    // and stop the product.
    const verdict = classifyAutomation({
      headers: bag({ from: 'Jane <jane@example.com>', subject: 'Re: your note' }),
      body: emptyBody,
    });
    expect(verdict.classification).toBe('NO_AUTOMATION_MARKERS');
    expect(mayReplyTo(verdict.classification)).toBe(true);
  });

  it('none of the new classes permit a reply', () => {
    for (const headers of [
      { 'content-type': 'multipart/report; report-type=disposition-notification' },
      { 'x-loop': 'x' },
      { 'x-auto-response-suppress': 'All' },
    ]) {
      expect(mayReplyTo(classOf(headers)), JSON.stringify(headers)).toBe(false);
    }
  });

  /**
   * The classifier must NOT start reading prose. `providerError.ts` records why: a
   * correspondent who writes the trigger word steers the decision, and the check does not
   * survive a language change. This is what keeps that true as signals get added.
   */
  it('the classifier reads headers and structure, never subject text', () => {
    const source = readFileSync('server/domain/automatedMail.ts', 'utf8');
    // Comments AND string literals are stripped. The reason strings legitimately say
    // "Automatic reply generated by an inbox rule" — that is the module explaining a verdict
    // it reached from a header, and an assertion that flagged it would be reading the fix as
    // the defect. What must not appear is a READ of the subject or of the body text.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    // Header NAMES are string literals and collapse to `''` under stripping, so a per-header
    // assertion is not available here — every read looks alike once the literals are gone.
    // What does survive is the body access, which is the thing that would let prose decide.
    expect(code, 'the classifier reads the plain-text body').not.toMatch(/\bbody\.text\b/);
    expect(code, 'the classifier reads the HTML body').not.toMatch(/\bbody\.html\b/);

    // And an out-of-office with no markers really does reach NO_AUTOMATION_MARKERS — which is
    // the gap the loop budget exists for, stated as a test rather than as a claim.
    expect(
      classOf({ from: 'Jane <jane@example.com>', subject: 'Out of Office: Re: your note' })
    ).toBe('NO_AUTOMATION_MARKERS');
    expect(
      classOf({ from: 'Jane <jane@example.com>', subject: 'Ausser Haus / fora do escritorio' })
    ).toBe('NO_AUTOMATION_MARKERS');
  });

  it('that check would catch a classifier that started reading prose', () => {
    // Without this, the stripping could remove everything and the assertions above would hold
    // on any file at all.
    const prose = "if (body.text.includes('out of office')) return OOO;";
    const stripped = prose
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    expect(stripped).toMatch(/\bbody\.text\b/);
    // ...while the reason strings that legitimately mention automatic replies do not survive
    // stripping, so they cannot be mistaken for a read.
    const reason = "reason: 'Automatic reply generated by an inbox rule.',";
    expect(reason.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")).not.toMatch(/automatic/i);
  });
});

describe('5. the gateway enforces it, and reads a history it cannot fake', () => {
  const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
  const outbox = readFileSync('server/services/outbox.service.ts', 'utf8');

  it('the send path calls the budget and refuses on it', () => {
    expect(gateway).toContain('replyLoopVerdict');
    expect(gateway).toMatch(/if \(loop\.allowed === false\)[\s\S]{0,300}?POLICY_BLOCKED/);
  });

  it('a send with no conversation is refused rather than exempted', () => {
    expect(gateway).toMatch(/if \(!request\.conversationId\)[\s\S]{0,400}?POLICY_BLOCKED/);
  });

  it('the history query returns null on failure, not an empty list', () => {
    // The single most important line in the query: `listByStatus` returns `[]` on error, and
    // reusing it here would turn a failed read into "no replies yet".
    const method = /async replyTimesForConversation[\s\S]*?\n  \}/.exec(outbox)![0];
    expect(method).toMatch(/catch[\s\S]{0,200}?return null;/);
    expect(method).not.toMatch(/catch[\s\S]{0,200}?return \[\];/);
    expect(method).toContain("where('status', '==', 'PROCESSED')");
  });

  it('those patterns would fail on the versions they are meant to prevent', () => {
    expect(/if \(loop\.allowed === false\)[\s\S]{0,300}?POLICY_BLOCKED/.test(
      'const loop = replyLoopVerdict(x);\n await gmailService.sendEmail({});'
    )).toBe(false);
    expect(/catch[\s\S]{0,200}?return \[\];/.test(
      "try { return q(); } catch (e) { console.error(e); return []; }"
    )).toBe(true);
  });
});
