import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  outboundMessageId,
  bareMessageId,
  isWellFormedMessageId,
  isValidMessageIdDomain,
  headerLine,
  assertSafeHeaderValue,
  UnsafeHeaderValueError,
  UnreconcilableSendError,
} from '../lib/messageIdentity';
import {
  reconcileEmailSend,
  mayRetryAfterReconciliation,
  wasApplied,
  DEFAULT_SETTLE_MS,
  type ReconciliationVerdict,
  type SentMessageLookup,
} from '../lib/reconciliation';
import { ProviderError } from '../lib/providerError';
import { HttpTimeoutError } from '../lib/httpClient';

/**
 * S32 — an ambiguous provider outcome, reconciled.
 *
 * P1.11 built the taxonomy and the gate: TIMEOUT/CONNECTION_FAILED/PROVIDER_UNAVAILABLE/UNKNOWN
 * are AMBIGUOUS, and `requiresReconciliation(error, irreversible)` says an irreversible action
 * must be reconciled before retry. Nothing acted on it. The worker dead-lettered every
 * ambiguous job under a comment that deferred to "the reconciliation worker", and there was no
 * reconciliation worker.
 *
 * These tests hold the three things that had to become true for that branch to stop being a
 * comment: the send carries an identity that can be asked about, the question has three
 * possible answers rather than one, and exactly one of those answers licenses a retry.
 */

const T0 = new Date('2026-09-07T12:00:00.000Z');
const at = (msAfter: number) => new Date(T0.getTime() + msAfter);

const lookupReturning = (
  value: { id: string; threadId: string } | null
): SentMessageLookup => ({
  providerName: 'gmail',
  findSentMessageByRfc822MessageId: async () => value,
});

const lookupThrowing = (error: unknown): SentMessageLookup => ({
  providerName: 'gmail',
  findSentMessageByRfc822MessageId: async () => {
    throw error;
  },
});

const ID = outboundMessageId('job-1', 'example.com');

// ===========================================================================
describe('the send carries an identity that can be asked about', () => {
  /**
   * The reason reconciliation stayed a comment is here, not in the worker. The outbound
   * message had no Message-ID of our choosing, so after a timeout the only available question
   * was "is there a message to this address with this subject?" — which cannot tell the send
   * that just timed out from the one that succeeded last week. An unanswerable question is not
   * a reconciliation.
   */

  it('THE SAME JOB PRODUCES THE SAME ID — every attempt, every process', () => {
    // The whole mechanism. A retry must ask about the message the first attempt sent.
    expect(outboundMessageId('job-1', 'example.com')).toBe(outboundMessageId('job-1', 'example.com'));
  });

  it('different jobs produce different ids', () => {
    expect(outboundMessageId('job-1', 'example.com')).not.toBe(
      outboundMessageId('job-2', 'example.com')
    );
  });

  it('the id does not publish the key it was derived from', () => {
    // A Message-ID travels in the clear to the recipient and every relay in between, and an
    // idempotency key can carry an email address or a conversation id.
    const id = outboundMessageId('conv_9:prospect@acme.example:v3', 'example.com');
    expect(id).not.toContain('prospect@acme.example');
    expect(id).not.toContain('conv_9');
  });

  it('it is a syntactically valid Message-ID', () => {
    expect(ID.startsWith('<')).toBe(true);
    expect(ID.endsWith('>')).toBe(true);
    expect(ID).toContain('@example.com');
    expect(isWellFormedMessageId(ID)).toBe(true);
  });

  it('A SEND WITH NO STABLE IDENTITY IS REFUSED, NOT GIVEN A RANDOM ONE', () => {
    // A random id is stable within one attempt and different on the retry, so it would answer
    // "did this send happen" with "no" every time — licensing exactly the duplicate §32 exists
    // to prevent, through the machinery built to prevent it.
    for (const missing of [undefined, null, '', '   ', 42, {}]) {
      expect(() => outboundMessageId(missing, 'example.com')).toThrow(UnreconcilableSendError);
    }
  });

  it('a send with no valid domain is refused too', () => {
    for (const bad of [undefined, null, '', 'localhost', 'not a domain', '.com', 'a..b.com', 123]) {
      expect(() => outboundMessageId('job-1', bad), String(bad)).toThrow(UnreconcilableSendError);
    }
    expect(isValidMessageIdDomain('mail.example.co.uk')).toBe(true);
  });

  it('the bracket form and the search form round-trip', () => {
    expect(bareMessageId(ID)).toBe(ID.slice(1, -1));
    expect(bareMessageId('a@b.com')).toBe('a@b.com');
  });

  it('a malformed id is not well-formed, so it never reaches a provider query', () => {
    for (const bad of ['', 'no-at-sign', '@nolocal', 'local@', 'has space@x.com', null, 7]) {
      expect(isWellFormedMessageId(bad), String(bad)).toBe(false);
    }
  });
});

// ===========================================================================
describe('a header value cannot become header structure (S16/§18)', () => {
  /**
   * The same lines that lacked a Message-ID also built every header by raw interpolation:
   *
   *     `Subject: ${opts.subject}`
   *
   * The reply subject is derived from the INBOUND subject. A customer who puts a CR-LF in
   * theirs ends that header and makes the remainder into headers of their own — Bcc: among
   * them. Data becoming structure is §18 in its most literal form.
   */

  it('THE ACTUAL ATTACK IS REFUSED — a Bcc smuggled through a reply subject', () => {
    const hostileSubject = 'Re: your quote\r\nBcc: everyone@competitor.example';
    expect(() => headerLine('Subject', hostileSubject)).toThrow(UnsafeHeaderValueError);
  });

  it('every character that terminates a header field is refused', () => {
    for (const c of ['\r', '\n', '\u0000']) {
      expect(() => assertSafeHeaderValue('Subject', `a${c}b`), JSON.stringify(c)).toThrow(
        UnsafeHeaderValueError
      );
    }
  });

  it('it refuses rather than strips', () => {
    // Silently deleting part of a subject changes what the recipient sees with no record, and
    // a subject containing a bare CR is an attack or a bug, never a typo.
    let threw = false;
    try {
      headerLine('Subject', 'hello\nworld');
    } catch (e) {
      threw = true;
      expect((e as Error).message).not.toContain('helloworld');
    }
    expect(threw).toBe(true);
  });

  it('ordinary subjects, including unicode and punctuation, pass through unchanged', () => {
    expect(headerLine('Subject', 'Re: £499/mo — can we talk?')).toBe(
      'Subject: Re: £499/mo — can we talk?'
    );
  });

  it('a non-string is refused rather than coerced', () => {
    expect(() => assertSafeHeaderValue('To', undefined as any)).toThrow(UnsafeHeaderValueError);
  });
});

// ===========================================================================
describe('the question has three answers, not one', () => {
  it('the provider holds it -> APPLIED, carrying the PROVIDER id', async () => {
    const r = await reconcileEmailSend(lookupReturning({ id: 'gmail-abc', threadId: 'th-1' }), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(1000),
    });
    expect(r.verdict).toBe('APPLIED');
    expect(r.providerMessageId).toBe('gmail-abc');
    expect(r.providerThreadId).toBe('th-1');
  });

  it('APPLIED does not depend on the settle window — presence is presence', async () => {
    const r = await reconcileEmailSend(lookupReturning({ id: 'gmail-abc', threadId: 'th-1' }), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(1),
    });
    expect(r.verdict).toBe('APPLIED');
  });

  it('absent, after the settle window -> NOT_APPLIED', async () => {
    const r = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('NOT_APPLIED');
  });

  it('ABSENT BUT TOO SOON -> STILL_UNKNOWN, not NOT_APPLIED', async () => {
    // A mailbox index is eventually consistent. Reading a one-second-old absence as failure
    // licenses a retry that delivers the message twice.
    const r = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(DEFAULT_SETTLE_MS - 1),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
  });

  it('THE BOUNDARY IS EXACT — one millisecond changes the verdict', async () => {
    const before = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(DEFAULT_SETTLE_MS - 1),
    });
    const on = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(DEFAULT_SETTLE_MS),
    });
    expect([before.verdict, on.verdict]).toEqual(['STILL_UNKNOWN', 'NOT_APPLIED']);
  });

  it('the settle window is a parameter, so a deployment can state its own', async () => {
    const r = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(5_000),
      settleMs: 1_000,
    });
    expect(r.verdict).toBe('NOT_APPLIED');
  });

  it('no attempt time -> STILL_UNKNOWN, because "too soon" cannot be judged', async () => {
    const r = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: null,
      now: at(10 * DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
  });

  it('an invalid attempt time is not silently treated as zero', async () => {
    const r = await reconcileEmailSend(lookupReturning(null), {
      rfc822MessageId: ID,
      attemptedAt: new Date('nonsense'),
      now: at(10 * DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
  });

  it('no identity to search on -> STILL_UNKNOWN', async () => {
    for (const bad of [null, undefined, '', 'not-a-message-id']) {
      const r = await reconcileEmailSend(lookupReturning(null), {
        rfc822MessageId: bad,
        attemptedAt: T0,
        now: at(10 * DEFAULT_SETTLE_MS),
      });
      expect(r.verdict, String(bad)).toBe('STILL_UNKNOWN');
    }
  });
});

// ===========================================================================
describe('a failed question is not a negative answer', () => {
  /**
   * This is the conflation that made `getHistory` return `[]` for a dead credential, so a
   * broken connection read as a quiet inbox (P1.11). Applied here it would be far worse:
   * "the search failed" becoming "the message is not there" licenses a duplicate send.
   */

  it('the lookup throwing -> STILL_UNKNOWN, and reconciliation itself does not throw', async () => {
    const r = await reconcileEmailSend(lookupThrowing(new HttpTimeoutError('https://x', 15000)), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(10 * DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
    expect(r.lookupErrorKind).toBe('TIMEOUT');
  });

  it('an unclassified throw is classified rather than escaping', async () => {
    const r = await reconcileEmailSend(lookupThrowing(new Error('something odd')), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(10 * DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
    expect(r.lookupErrorKind).toBe('UNKNOWN');
  });

  it('a ProviderError passes through with its own kind', async () => {
    const r = await reconcileEmailSend(
      lookupThrowing(
        new ProviderError({ provider: 'gmail', operation: 'x', kind: 'UNAUTHENTICATED', signal: 's' })
      ),
      { rfc822MessageId: ID, attemptedAt: T0, now: at(10 * DEFAULT_SETTLE_MS) }
    );
    expect(r.lookupErrorKind).toBe('UNAUTHENTICATED');
  });

  it('a non-Error thrown value still yields a verdict', async () => {
    const r = await reconcileEmailSend(lookupThrowing('a string'), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(10 * DEFAULT_SETTLE_MS),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
  });

  it('A FABRICATED ID IS NOT WEAK EVIDENCE OF DELIVERY, IT IS NONE', async () => {
    // P0.8 applied to the other direction of the same claim: an id we could have minted
    // ourselves proves nothing about what the provider did.
    for (const id of ['sim_123', 'mock_abc', 'test-1', 'fake_x', 'stub_y']) {
      const r = await reconcileEmailSend(lookupReturning({ id, threadId: 't' }), {
        rfc822MessageId: ID,
        attemptedAt: T0,
        now: at(1000),
      });
      expect(r.verdict, id).toBe('STILL_UNKNOWN');
      expect(r.providerMessageId, id).toBeNull();
    }
  });

  it('an empty id from the lookup is refused as evidence', async () => {
    const r = await reconcileEmailSend(lookupReturning({ id: '', threadId: 't' }), {
      rfc822MessageId: ID,
      attemptedAt: T0,
      now: at(1000),
    });
    expect(r.verdict).toBe('STILL_UNKNOWN');
  });

  it('every verdict carries evidence an operator can read', async () => {
    const cases = await Promise.all([
      reconcileEmailSend(lookupReturning({ id: 'g1', threadId: 't' }), { rfc822MessageId: ID, attemptedAt: T0, now: at(1) }),
      reconcileEmailSend(lookupReturning(null), { rfc822MessageId: ID, attemptedAt: T0, now: at(DEFAULT_SETTLE_MS) }),
      reconcileEmailSend(lookupReturning(null), { rfc822MessageId: ID, attemptedAt: T0, now: at(1) }),
      reconcileEmailSend(lookupThrowing(new Error('x')), { rfc822MessageId: ID, attemptedAt: T0, now: at(1) }),
    ]);
    for (const c of cases) {
      expect(c.evidence.length).toBeGreaterThan(30);
    }
  });
});

// ===========================================================================
describe('exactly one answer licenses a retry', () => {
  /**
   * The whole safety property reduces to this predicate. It is written as an equality against
   * the one permitting value rather than as a negation of the forbidding ones, so a verdict
   * added to the union later is refused by default instead of inheriting permission.
   */

  it('NOT_APPLIED permits retry; APPLIED and STILL_UNKNOWN do not', () => {
    expect(mayRetryAfterReconciliation('NOT_APPLIED')).toBe(true);
    expect(mayRetryAfterReconciliation('APPLIED')).toBe(false);
    expect(mayRetryAfterReconciliation('STILL_UNKNOWN')).toBe(false);
  });

  it('THE PREDICATE IS EXHAUSTIVE OVER THE UNION — a new verdict cannot inherit permission', () => {
    // The compiler holds this list to the union; this asserts the runtime rule over all of it.
    const all: ReconciliationVerdict[] = ['APPLIED', 'NOT_APPLIED', 'STILL_UNKNOWN'];
    expect(all.filter(mayRetryAfterReconciliation)).toEqual(['NOT_APPLIED']);
    expect(all.filter(wasApplied)).toEqual(['APPLIED']);
  });

  it('an unknown string does not accidentally permit a retry', () => {
    expect(mayRetryAfterReconciliation('SOMETHING_NEW' as ReconciliationVerdict)).toBe(false);
  });
});

// ===========================================================================
describe('the Gmail adapter, exercised', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * These drive the real adapter against a stubbed transport rather than asserting on the
   * source text. A test that greps for a header name passes just as happily when the header is
   * built and discarded.
   */

  const loadGmail = async () => {
    const mod = await import('../services/gmail.service');
    const svc = new mod.GmailService();
    svc.setCredentials({ access_token: 'tok' });
    return svc;
  };

  it('THE MESSAGE-ID REACHES THE WIRE — decoded from the raw MIME the adapter sent', async () => {
    let captured: any = null;
    vi.stubGlobal('fetch', async (_url: string, init: any) => {
      captured = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ id: 'g1', threadId: 't1' }) };
    });
    const svc = await loadGmail();
    await svc.sendEmail({
      to: 'a@b.example',
      subject: 'Hello',
      bodyHtml: '<p>hi</p>',
      rfc822MessageId: ID,
    });

    const raw = Buffer.from(
      captured.raw.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('utf8');
    expect(raw).toContain(`Message-ID: ${ID}`);
    expect(raw).toContain('To: a@b.example');
    expect(raw).toContain('Subject: Hello');
  });

  it('a header-injecting subject stops the send instead of reaching the wire', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ id: 'g1', threadId: 't1' }) };
    });
    const svc = await loadGmail();
    await expect(
      svc.sendEmail({
        to: 'a@b.example',
        subject: 'Re: hi\r\nBcc: victim@example.com',
        bodyHtml: '<p>x</p>',
        rfc822MessageId: ID,
      })
    ).rejects.toThrow(UnsafeHeaderValueError);
    expect(called).toBe(false);
  });

  it('THE SEARCH ASKS THE EXACT QUESTION — rfc822msgid, scoped to sent', async () => {
    let url = '';
    vi.stubGlobal('fetch', async (u: string) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'g9', threadId: 't9' }] }) };
    });
    const svc = await loadGmail();
    const found = await svc.findSentMessageByRfc822MessageId(ID);

    const decoded = decodeURIComponent(url);
    expect(decoded).toContain('rfc822msgid:' + bareMessageId(ID));
    // in:sent, because a message with this id in the INBOX would be a copy we received, and
    // reading that as proof we sent it is how a reconciliation mistakes a bounce for delivery.
    expect(decoded).toContain('in:sent');
    expect(found).toEqual({ id: 'g9', threadId: 't9' });
  });

  it('no match is null, and a failed query throws — never the other way round', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const svc = await loadGmail();
    expect(await svc.findSentMessageByRfc822MessageId(ID)).toBeNull();

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => null } }));
    const svc2 = await loadGmail();
    await expect(svc2.findSentMessageByRfc822MessageId(ID)).rejects.toThrow(ProviderError);
  });

  it('a 200 that matched but carried no id throws rather than confirming a send', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ threadId: 't' }] }),
    }));
    const svc = await loadGmail();
    await expect(svc.findSentMessageByRfc822MessageId(ID)).rejects.toThrow(ProviderError);
  });

  it('the adapter refuses to build a query from a malformed id', async () => {
    let called = false;
    vi.stubGlobal('fetch', async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const svc = await loadGmail();
    await expect(svc.findSentMessageByRfc822MessageId('garbage')).rejects.toThrow(ProviderError);
    expect(called).toBe(false);
  });
});

// ===========================================================================
describe('the gateway and the worker act on the verdict', () => {
  const gateway = stripped('server/gateway/actionGateway.ts');
  const worker = stripped('server/workers/outbox.worker.ts');

  it('the gateway reconciles instead of only flagging', () => {
    expect(gateway).toContain('const reconciliation = await this.reconcileAmbiguous(');
    expect(gateway).toContain('reconcileEmailSend(gmailService, {');
  });

  it('the send derives its identity from the job idempotency key', () => {
    expect(gateway).toContain('rfc822MessageId = outboundMessageId(');
    expect(gateway).toContain('request.payload.idempotencyKey');
    // and the worker actually supplies it, or the derivation refuses on every send
    expect(worker).toContain('idempotencyKey: job.idempotencyKey');
  });

  it('THE IDENTITY REACHES THE SEND CALL, not merely the file', () => {
    // Deleting `rfc822MessageId` from the sendEmail arguments survived a first mutation run:
    // the assertion was `gateway.toContain('rfc822MessageId,')`, and the reconciliation call
    // a hundred lines below contains that same text. A needle that matches somewhere else in
    // the file is a claim about the file, not about the call.
    const call = gateway.slice(gateway.indexOf('await gmailService.sendEmail({'));
    const args = call.slice(0, call.indexOf('});'));
    expect(args).toContain('rfc822MessageId,');
    expect(args).toContain('to: request.payload.to,');
  });

  it('AN UNRECONCILABLE SEND IS REFUSED BEFORE THE NETWORK', () => {
    expect(gateway).toContain("errorCode: 'UNRECONCILABLE_SEND'");
    expect(worker).toContain("result.errorCode === 'UNRECONCILABLE_SEND'");
  });

  it('an APPLIED verdict reports success, so the message is recorded rather than lost', () => {
    expect(gateway).toContain('if (wasApplied(reconciliation.verdict))');
    expect(gateway).toMatch(/success: true,\s*\n\s*providerResult: \{\s*\n\s*messageId: reconciliation\.providerMessageId/);
  });

  it('THE WORKER RETRIES ONLY ON NOT_APPLIED', () => {
    expect(worker).toContain("if (verdict === 'NOT_APPLIED')");
    // the retryable call has no terminal flag; the other branch passes true
    const notApplied = worker.slice(worker.indexOf("if (verdict === 'NOT_APPLIED')"));
    const retryCall = notApplied.slice(0, notApplied.indexOf('} else {'));
    expect(retryCall).toContain('RECONCILED_NOT_APPLIED');
    expect(retryCall).not.toContain('true\n');
  });

  it('an unreconciled ambiguity is still dead-lettered', () => {
    expect(worker).toContain('AMBIGUOUS_PROVIDER_RESULT: reconciliation returned');
  });

  it('a reconciliation verdict is recorded in the audit log', () => {
    expect(gateway).toContain('RECONCILED_${reconciliation.verdict}');
  });

  it('an action type with no reconciliation is NOT treated as reconciled', () => {
    // "We could not check, so assume it did not happen" is the §14 failure: unknown becoming
    // permission — here, permission to repeat an irreversible action.
    expect(gateway).toContain('No reconciliation is implemented for ');
    const fn = gateway.slice(gateway.indexOf('private async reconcileAmbiguous('));
    const body = fn.slice(0, fn.indexOf('return reconcileEmailSend('));
    expect(body).toContain("verdict: 'STILL_UNKNOWN'");
    expect(body).not.toContain("verdict: 'NOT_APPLIED'");
  });

  it('the gateway takes an injectable clock, so the settle boundary is testable', () => {
    expect(gateway).toContain('constructor(private readonly clock: Clock = systemClock) {}');
    expect(gateway).toContain('const attemptedAt = this.clock.now();');
  });
});

function stripped(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
