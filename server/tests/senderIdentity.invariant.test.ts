import { describe, it, expect } from 'vitest';
import {
  evaluateSenderRecords,
  posturePermitsSending,
  domainOfAddress,
  type SenderRecords,
} from '../domain/senderIdentity';

/**
 * INVARIANTS FOR SENDER IDENTITY HEALTH (S27).
 *
 * The evaluator is pure and these are real record shapes — Google Workspace's SPF include, a
 * DMARC record with a policy and an aggregate address, a DKIM key at the `google` selector — so
 * every rule is exercised without a resolver. The rules that matter most are the ones about what
 * is NOT known: a failed lookup is UNKNOWN and never MISSING, and UNKNOWN does not permit sending.
 */

const ok = (...records: string[]) => ({ ok: true as const, records });
const failed = (error: string) => ({ ok: false as const, error });
const google = (over: Partial<SenderRecords> = {}): SenderRecords => ({
  domain: 'example.co.uk',
  spf: ok('v=spf1 include:_spf.google.com ~all'),
  dmarc: ok('v=DMARC1; p=reject; rua=mailto:dmarc@example.co.uk'),
  dkim: [{ selector: 'google', answer: ok('v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC') }],
  ...over,
});

// =============================================================================================
describe('1. a domain set up the way Google documents it is READY', () => {
  it('SPF with a soft fail, DMARC reject with reports, a DKIM key at google._domainkey', () => {
    const p = evaluateSenderRecords(google());
    expect(p.verdict).toBe('READY');
    expect(p.spf).toMatchObject({ state: 'PRESENT', policy: 'softfail' });
    expect(p.dmarc).toMatchObject({ state: 'PRESENT', policy: 'reject' });
    expect(p.dkim).toMatchObject({ state: 'PRESENT', policy: 'google' });
    expect(p.reasons).toEqual([]);
    expect(posturePermitsSending(p)).toBe(true);
  });

  it('TXT chunks and case do not matter; a v=spf1 record among other TXT records is found', () => {
    const p = evaluateSenderRecords(google({ spf: ok('google-site-verification=abc', 'V=SPF1 include:_spf.google.com -all') }));
    expect(p.spf).toMatchObject({ state: 'PRESENT', policy: 'fail' });
  });
});

// =============================================================================================
describe('2. what is absent is MISSING, and MISSING does not permit sending', () => {
  it('THE INVARIANT — no SPF record', () => {
    const p = evaluateSenderRecords(google({ spf: ok('google-site-verification=abc') }));
    expect(p.verdict).toBe('MISSING');
    expect(p.spf.state).toBe('MISSING');
    expect(p.reasons.join(' ')).toContain('SPF MISSING');
    expect(posturePermitsSending(p)).toBe(false);
  });

  it('no DMARC record', () => {
    const p = evaluateSenderRecords(google({ dmarc: ok() }));
    expect(p.verdict).toBe('MISSING');
    expect(p.dmarc.state).toBe('MISSING');
    expect(posturePermitsSending(p)).toBe(false);
  });

  it('two SPF records is INVALID — a permanent error at every receiver, not "present twice"', () => {
    const p = evaluateSenderRecords(google({ spf: ok('v=spf1 include:_spf.google.com ~all', 'v=spf1 ip4:203.0.113.4 -all') }));
    expect(p.spf.state).toBe('INVALID');
    expect(p.spf.detail).toContain('RFC 7208');
    expect(p.verdict).toBe('MISSING');
  });

  it('a DMARC record without a policy is INVALID', () => {
    const p = evaluateSenderRecords(google({ dmarc: ok('v=DMARC1; rua=mailto:dmarc@example.co.uk') }));
    expect(p.dmarc.state).toBe('INVALID');
    expect(p.verdict).toBe('MISSING');
  });
});

// =============================================================================================
describe('3. what could not be asked is UNKNOWN, never MISSING, and does not permit sending', () => {
  it('THE INVARIANT — a failed SPF lookup', () => {
    const p = evaluateSenderRecords(google({ spf: failed('queryTxt ETIMEOUT example.co.uk') }));
    expect(p.spf.state).toBe('UNKNOWN');
    expect(p.verdict).toBe('UNKNOWN');
    expect(p.reasons[0]).toContain('lookup failed');
    expect(posturePermitsSending(p)).toBe(false);
  });

  it('a failed DMARC lookup', () => {
    const p = evaluateSenderRecords(google({ dmarc: failed('SERVFAIL') }));
    expect(p.verdict).toBe('UNKNOWN');
  });

  it('a failed DKIM lookup alone is WEAK with the failure named, because sending can still align on SPF', () => {
    const p = evaluateSenderRecords(google({ dkim: [{ selector: 'google', answer: failed('ETIMEOUT') }] }));
    expect(p.dkim.state).toBe('UNKNOWN');
    expect(p.verdict).toBe('WEAK');
    expect(posturePermitsSending(p)).toBe(true);
  });

  it('UNKNOWN takes precedence over MISSING: a domain that could not be asked is not called unconfigured', () => {
    const p = evaluateSenderRecords(google({ spf: failed('ETIMEOUT'), dmarc: ok() }));
    expect(p.verdict).toBe('UNKNOWN');
  });
});

// =============================================================================================
describe('4. what is present but weak is WEAK: sending proceeds, the operator is told why', () => {
  it('DMARC p=none', () => {
    const p = evaluateSenderRecords(google({ dmarc: ok('v=DMARC1; p=none; rua=mailto:x@example.co.uk') }));
    expect(p.verdict).toBe('WEAK');
    expect(p.reasons.join(' ')).toContain('p=none');
    expect(posturePermitsSending(p)).toBe(true);
  });

  it('SPF ending +all authorises everyone', () => {
    const p = evaluateSenderRecords(google({ spf: ok('v=spf1 include:_spf.google.com +all') }));
    expect(p.spf.policy).toBe('pass');
    expect(p.verdict).toBe('WEAK');
    expect(p.reasons.join(' ')).toContain('+all');
  });

  it('SPF with no "all" at all', () => {
    const p = evaluateSenderRecords(google({ spf: ok('v=spf1 include:_spf.google.com') }));
    expect(p.spf.policy).toBe('no-all');
    expect(p.verdict).toBe('WEAK');
  });

  it('but an SPF that redirects has its policy elsewhere, and is not weak for lacking "all"', () => {
    // gmail.com's own record. The first version of the evaluator called it weak; real DNS said
    // otherwise, and RFC 7208 §6.1 agrees.
    const p = evaluateSenderRecords(google({ spf: ok('v=spf1 redirect=_spf.google.com') }));
    expect(p.spf).toMatchObject({ state: 'PRESENT', policy: 'redirect' });
    expect(p.spf.detail).toContain("_spf.google.com's");
    expect(p.verdict).toBe('READY');
  });

  it('no DKIM key at any configured selector', () => {
    const p = evaluateSenderRecords(google({ dkim: [{ selector: 'google', answer: ok() }, { selector: 'selector1', answer: ok() }] }));
    expect(p.dkim.state).toBe('MISSING');
    expect(p.dkim.detail).toContain('google, selector1');
    expect(p.verdict).toBe('WEAK');
  });

  it('a revoked DKIM key (empty p=) is INVALID and weakens the posture', () => {
    const p = evaluateSenderRecords(google({ dkim: [{ selector: 'google', answer: ok('v=DKIM1; k=rsa; p=') }] }));
    expect(p.dkim.state).toBe('INVALID');
    expect(p.verdict).toBe('WEAK');
  });

  it('DMARC without rua is still PRESENT, and says nobody receives reports', () => {
    const p = evaluateSenderRecords(google({ dmarc: ok('v=DMARC1; p=quarantine') }));
    expect(p.dmarc.state).toBe('PRESENT');
    expect(p.dmarc.detail).toContain('no rua=');
    expect(p.verdict).toBe('READY');
  });
});

// =============================================================================================
describe('5. the domain of an address', () => {
  it('is the part after the last @, lowercased', () => {
    expect(domainOfAddress('Nayem@Example.co.uk')).toBe('example.co.uk');
    expect(domainOfAddress('"a@b" <x@sub.example.com>')).toBe('sub.example.com');
  });
  it('is null when there is none, rather than the whole string', () => {
    for (const bad of [null, undefined, '', 'nobody', 'x@', '@example.com', 'x@localhost']) {
      expect(domainOfAddress(bad as string), String(bad)).toBeNull();
    }
  });
});
