import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { HttpTimeoutError } from '../lib/httpClient';
import {
  KIND_DISPOSITION,
  PROVIDER_ERROR_KINDS,
  ProviderError,
  type ProviderErrorKind,
  classifyResponse,
  classifyThrown,
  kindForStatus,
  parseRetryAfter,
  requiresReconciliation,
} from '../lib/providerError';
import {
  CAPABILITIES,
  CapabilityError,
  REQUESTED_SCOPES,
  assertCapability,
  capabilitiesOf,
  checkCapability,
  normalizeScopes,
} from '../lib/capabilities';

const ctx = { provider: 'gmail', operation: 'EMAIL_SEND' };
const NOW = new Date('2026-09-07T12:00:00Z');

/** A stand-in for a fetch Response, carrying only what classification is allowed to read. */
const response = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

describe('P1.11 — provider errors classified from structure', () => {
  // -------------------------------------------------------------------------
  describe('the defect: the old substring test was inverted in both directions', () => {
    it('"timed out" does not contain "timeout" — the old test missed this repo’s own timeout', () => {
      const thrown = new HttpTimeoutError('https://gmail.googleapis.com/send', 15_000);
      // The exact expression the gateway used, reproduced.
      const oldVerdict = thrown.message.includes('timeout') || thrown.message.includes('network');
      expect(thrown.message).toContain('timed out');
      expect(oldVerdict).toBe(false);

      // The new classifier reads the TYPE, so the wording cannot matter.
      const classified = classifyThrown(thrown, ctx);
      expect(classified.kind).toBe('TIMEOUT');
      expect(classified.isAmbiguous).toBe(true);
      expect(classified.signal).toBe('HttpTimeoutError');
    });

    it('every real provider failure was missed by the old test', () => {
      const realMessages = [
        'Request to https://gmail.googleapis.com/send timed out after 15000ms',
        'fetch failed',
        'socket hang up',
        'read ECONNRESET',
        'Rate Limit Exceeded',
        'Backend Error',
        '504 Gateway Timeout',
        'Invalid Credentials',
      ];
      for (const message of realMessages) {
        expect(message.includes('timeout') || message.includes('network')).toBe(false);
      }
    });

    it('a customer could flip the old test by writing "timeout" in a subject line', () => {
      // Provider errors quote request content, and request content is untrusted (§18).
      const attacker = 'Invalid value for field subject: "can we discuss the timeout issue?"';
      expect(attacker.includes('timeout')).toBe(true);
      // The new classifier has no branch that reads the message at all.
      const source = readFileSync('server/lib/providerError.ts', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(source).not.toMatch(/\.message\s*\??\.\s*(includes|match|startsWith|indexOf|search)/);
    });
  });

  // -------------------------------------------------------------------------
  describe('classification reads type, code and status — never prose', () => {
    it('AbortError and TimeoutError are timeouts', () => {
      for (const name of ['AbortError', 'TimeoutError']) {
        const e = Object.assign(new Error('anything at all'), { name });
        expect(classifyThrown(e, ctx).kind).toBe('TIMEOUT');
      }
    });

    it('socket codes map by what they say about the side effect', () => {
      const cases: [string, ProviderErrorKind][] = [
        ['ETIMEDOUT', 'TIMEOUT'],
        ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'],
        ['ECONNRESET', 'CONNECTION_FAILED'],
        ['ECONNREFUSED', 'CONNECTION_FAILED'],
        ['ENOTFOUND', 'CONNECTION_FAILED'],
        ['EAI_AGAIN', 'CONNECTION_FAILED'],
      ];
      for (const [code, kind] of cases) {
        expect(classifyThrown(Object.assign(new Error('x'), { code }), ctx).kind).toBe(kind);
        // undici nests the real code under `cause`, which is where it actually shows up.
        expect(classifyThrown(Object.assign(new Error('fetch failed'), { cause: { code } }), ctx).kind).toBe(kind);
      }
    });

    it('HTTP statuses map to kinds by class, so an unseen status still lands somewhere sane', () => {
      const cases: [number, ProviderErrorKind][] = [
        [400, 'INVALID_REQUEST'],
        [401, 'UNAUTHENTICATED'],
        [403, 'PERMISSION_DENIED'],
        [404, 'NOT_FOUND'],
        [408, 'TIMEOUT'],
        [409, 'CONFLICT'],
        [422, 'INVALID_REQUEST'],
        [429, 'RATE_LIMITED'],
        [500, 'PROVIDER_UNAVAILABLE'],
        [502, 'PROVIDER_UNAVAILABLE'],
        [503, 'PROVIDER_UNAVAILABLE'],
        [504, 'PROVIDER_UNAVAILABLE'],
        [599, 'PROVIDER_UNAVAILABLE'],
      ];
      for (const [status, kind] of cases) expect(kindForStatus(status)).toBe(kind);
    });

    it('an unclassifiable error is UNKNOWN, and UNKNOWN is AMBIGUOUS', () => {
      // This is the §14 decision. Treating "we could not tell" as a definite failure would
      // grant permission to retry something that may already have happened.
      const classified = classifyThrown(new Error('something nobody anticipated'), ctx);
      expect(classified.kind).toBe('UNKNOWN');
      expect(classified.outcome).toBe('AMBIGUOUS');
      expect(classified.mayRetryWithoutReconciliation(true)).toBe(false);
    });

    it('a non-Error value does not crash the classifier', () => {
      for (const thrown of [null, undefined, 'a string', 42, {}, []]) {
        const classified = classifyThrown(thrown, ctx);
        expect(PROVIDER_ERROR_KINDS).toContain(classified.kind);
        expect(classified.outcome).toBe('AMBIGUOUS');
      }
    });

    it('an already-classified error passes through unchanged', () => {
      const original = new ProviderError({ ...ctx, kind: 'RATE_LIMITED', signal: 'http status=429' });
      expect(classifyThrown(original, ctx)).toBe(original);
    });

    it('classifyResponse records the status structurally and never reads a body', () => {
      const classified = classifyResponse(response(429, { 'retry-after': '30' }), { ...ctx, now: NOW });
      expect(classified.kind).toBe('RATE_LIMITED');
      expect(classified.status).toBe(429);
      expect(classified.retryAfterSeconds).toBe(30);
      expect(classified.signal).toBe('http status=429');
    });

    it('Retry-After parses seconds and HTTP dates, and refuses anything else', () => {
      expect(parseRetryAfter('120', NOW)).toBe(120);
      expect(parseRetryAfter('0', NOW)).toBe(0);
      expect(parseRetryAfter('Mon, 07 Sep 2026 12:01:00 GMT', NOW)).toBe(60);
      // A date already past means "you may go now", not a negative wait.
      expect(parseRetryAfter('Mon, 07 Sep 2026 11:00:00 GMT', NOW)).toBe(0);
      for (const bad of [null, undefined, '', '  ', 'soon', 'NaN']) {
        expect(parseRetryAfter(bad, NOW)).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('the §32 gate: a timeout is not a failure', () => {
    it('every kind has a disposition, and the table covers the enum exactly', () => {
      expect(Object.keys(KIND_DISPOSITION).sort()).toEqual([...PROVIDER_ERROR_KINDS].sort());
      for (const kind of PROVIDER_ERROR_KINDS) {
        expect(['NOT_APPLIED', 'AMBIGUOUS']).toContain(KIND_DISPOSITION[kind].outcome);
        expect(KIND_DISPOSITION[kind].rationale.length).toBeGreaterThan(20);
      }
    });

    it('the kinds that mean "we do not know" are AMBIGUOUS', () => {
      for (const kind of ['TIMEOUT', 'CONNECTION_FAILED', 'PROVIDER_UNAVAILABLE', 'UNKNOWN'] as const) {
        expect(KIND_DISPOSITION[kind].outcome).toBe('AMBIGUOUS');
      }
    });

    it('the kinds that mean "the provider refused before acting" are NOT_APPLIED', () => {
      for (const kind of [
        'RATE_LIMITED',
        'UNAUTHENTICATED',
        'PERMISSION_DENIED',
        'NOT_FOUND',
        'INVALID_REQUEST',
        'CONFLICT',
      ] as const) {
        expect(KIND_DISPOSITION[kind].outcome).toBe('NOT_APPLIED');
      }
    });

    it('an AMBIGUOUS failure on an IRREVERSIBLE action may not be retried without reconciling', () => {
      // The whole point. A send that timed out may have been delivered.
      const timeout = classifyThrown(new HttpTimeoutError('https://x', 15_000), ctx);
      expect(requiresReconciliation(timeout, true)).toBe(true);
      expect(timeout.mayRetryWithoutReconciliation(true)).toBe(false);
    });

    it('the same failure on a REVERSIBLE action may be retried freely', () => {
      const timeout = classifyThrown(new HttpTimeoutError('https://x', 15_000), ctx);
      expect(requiresReconciliation(timeout, false)).toBe(false);
      expect(timeout.mayRetryWithoutReconciliation(false)).toBe(true);
    });

    it('a 429 on an irreversible send IS retryable — the provider never processed it', () => {
      const limited = classifyResponse(response(429), ctx);
      expect(limited.outcome).toBe('NOT_APPLIED');
      expect(limited.mayRetryWithoutReconciliation(true)).toBe(true);
    });

    it('a 400 is never retryable, reversible or not — it is our defect', () => {
      const bad = classifyResponse(response(400), ctx);
      expect(bad.mayRetryWithoutReconciliation(false)).toBe(false);
      expect(bad.mayRetryWithoutReconciliation(true)).toBe(false);
    });

    it('a 403 is not retryable but a 401 is: one needs a person, the other needs a refresh', () => {
      expect(classifyResponse(response(403), ctx).mayRetryWithoutReconciliation(false)).toBe(false);
      expect(classifyResponse(response(401), ctx).mayRetryWithoutReconciliation(false)).toBe(true);
    });

    it('irreversibility is a required argument, because forgetting it answers unsafely', () => {
      const timeout = classifyThrown(new HttpTimeoutError('https://x', 15_000), ctx);

      // Omitting the argument must be a COMPILE error, and `tsc` enforces that claim: if the
      // parameter ever gains a default, this line stops erroring and the directive below fails
      // the build as unused. (The directive must sit immediately above the code — a further
      // comment line in between makes it target the comment, which is how I first wrote it.)
      // @ts-expect-error
      const forgotten = timeout.mayRetryWithoutReconciliation();

      // And this is why the type has to carry it. With the argument missing, the runtime answer
      // is `true` — "go ahead and retry" — for a send that may already have been delivered. A
      // defaulted parameter would make that the behaviour of every caller who forgot.
      expect(forgotten).toBe(true);
      expect(timeout.mayRetryWithoutReconciliation(true)).toBe(false);
    });

    it('the log record carries the evidence and not the provider’s prose', () => {
      const classified = classifyResponse(response(503, { 'retry-after': '5' }), ctx);
      const record = classified.toLogRecord();
      expect(record).toMatchObject({
        kind: 'PROVIDER_UNAVAILABLE',
        provider: 'gmail',
        status: 503,
        retryAfterSeconds: 5,
        outcome: 'AMBIGUOUS',
      });
      expect(JSON.stringify(record)).not.toContain('Backend Error');
    });
  });

  // -------------------------------------------------------------------------
  describe('capabilities: an unrecorded grant is not a grant', () => {
    const connection = (scopes: readonly string[] | null | undefined) => ({
      provider: 'gmail',
      organizationId: 'org_1',
      scopes,
      status: 'ACTIVE',
      expiresAt: null,
    });

    it('a send scope grants EMAIL_SEND', () => {
      const verdict = checkCapability(
        connection(['https://www.googleapis.com/auth/gmail.send']),
        'EMAIL_SEND',
        NOW
      );
      expect(verdict.granted).toBe(true);
    });

    it('a READONLY token is refused for sending — before anything leaves the process', () => {
      // This is what used to reach Google and come back 403, after dispatch and after logging.
      const verdict = checkCapability(
        connection(['https://www.googleapis.com/auth/gmail.readonly']),
        'EMAIL_SEND',
        NOW
      );
      expect(verdict.granted).toBe(false);
      if (verdict.granted === false) expect(verdict.reason).toBe('SCOPE_NOT_GRANTED');
    });

    it('NO recorded scopes is a refusal, not a blank cheque', () => {
      // Every existing connection is in this state, because scopes were never stored. Failing
      // closed here is deliberate: §14, and §A's "production action flags must fail closed".
      for (const missing of [null, undefined]) {
        const verdict = checkCapability(connection(missing), 'EMAIL_SEND', NOW);
        expect(verdict.granted).toBe(false);
        if (verdict.granted === false) {
          expect(verdict.reason).toBe('NO_SCOPES_RECORDED');
          expect(verdict.detail).toContain('Reconnect');
        }
      }
    });

    it('an unreviewed scope grants nothing rather than being assumed harmless', () => {
      expect(capabilitiesOf(['https://www.googleapis.com/auth/drive']).size).toBe(0);
      expect(capabilitiesOf(['', 'nonsense', 'gmail.send']).size).toBe(0);
    });

    it('a broad scope grants the capabilities it really implies', () => {
      const granted = capabilitiesOf(['https://mail.google.com/']);
      expect([...granted].sort()).toEqual(['EMAIL_MODIFY', 'EMAIL_READ', 'EMAIL_SEND']);
    });

    it('an inactive connection is refused whatever its scopes say', () => {
      const verdict = checkCapability(
        { ...connection(['https://www.googleapis.com/auth/gmail.send']), status: 'REVOKED' },
        'EMAIL_SEND',
        NOW
      );
      expect(verdict.granted).toBe(false);
      if (verdict.granted === false) expect(verdict.reason).toBe('CONNECTION_INACTIVE');
    });

    it('an expired credential is refused, and the boundary is exact', () => {
      const scoped = connection(['https://www.googleapis.com/auth/gmail.send']);
      const expired = { ...scoped, expiresAt: new Date(NOW.getTime() - 1) };
      const live = { ...scoped, expiresAt: new Date(NOW.getTime() + 1) };
      const exactly = { ...scoped, expiresAt: new Date(NOW.getTime()) };
      expect(checkCapability(expired, 'EMAIL_SEND', NOW).granted).toBe(false);
      expect(checkCapability(live, 'EMAIL_SEND', NOW).granted).toBe(true);
      // At the instant of expiry the credential is expired, not valid.
      expect(checkCapability(exactly, 'EMAIL_SEND', NOW).granted).toBe(false);
    });

    it('an absent expiry means unknown, and does not by itself refuse', () => {
      const verdict = checkCapability(connection(['https://www.googleapis.com/auth/gmail.send']), 'EMAIL_SEND', NOW);
      expect(verdict.granted).toBe(true);
    });

    it('assertCapability throws a non-retryable CapabilityError', () => {
      try {
        assertCapability(connection(['https://www.googleapis.com/auth/gmail.readonly']), 'EMAIL_SEND', NOW);
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(CapabilityError);
        expect((e as CapabilityError).retryable).toBe(false);
      }
    });

    it('normalizeScopes handles the space-delimited string Google actually returns', () => {
      expect(normalizeScopes('https://a https://b')).toEqual(['https://a', 'https://b']);
      expect(normalizeScopes(['https://a', 'https://b'])).toEqual(['https://a', 'https://b']);
      // Empty is "not recorded", NOT "we know it has none" — those differ, and only one of
      // them could ever be mistaken for a deliberate empty grant.
      for (const empty of ['', '   ', [], [''], null, undefined, 42, {}]) {
        expect(normalizeScopes(empty)).toBeNull();
      }
    });

    it('every requested scope is one this code can actually interpret', () => {
      // A scope we ask a user to consent to but cannot map grants nothing, which would refuse
      // every action while looking correctly configured.
      for (const scope of REQUESTED_SCOPES) expect(capabilitiesOf([scope]).size).toBeGreaterThan(0);
    });

    it('the capability list and the grant table agree', () => {
      const reachable = new Set<string>();
      for (const scope of Object.keys({
        'https://www.googleapis.com/auth/gmail.send': 1,
        'https://mail.google.com/': 1,
        'https://www.googleapis.com/auth/calendar': 1,
      })) {
        for (const capability of capabilitiesOf([scope])) reachable.add(capability);
      }
      for (const capability of CAPABILITIES) expect(reachable.has(capability)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('the live paths use it', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('the gateway classifies structurally and no longer greps error text', () => {
      const gateway = strip(readFileSync('server/gateway/actionGateway.ts', 'utf8'));
      expect(gateway).toContain('const classified = classifyThrown(e, {');
      expect(gateway).toContain('requiresReconciliation(classified, irreversible)');
      expect(gateway).not.toContain("e.message.includes('timeout')");
      expect(gateway).not.toContain("e.message?.includes('timeout')");
    });

    it('the gateway asks about capability BEFORE dispatching', () => {
      const gateway = strip(readFileSync('server/gateway/actionGateway.ts', 'utf8'));
      const preflight = gateway.indexOf('checkProviderCapability(request, requiredCapability)');
      const routing = gateway.indexOf('switch (request.actionType)');
      expect(preflight).toBeGreaterThan(-1);
      expect(routing).toBeGreaterThan(-1);
      expect(preflight).toBeLessThan(routing);
    });

    it('an unknown action type is treated as irreversible', () => {
      const gateway = strip(readFileSync('server/gateway/actionGateway.ts', 'utf8'));
      expect(gateway).toMatch(/export function isIrreversible[\s\S]{0,900}?default:\s*\n\s*return true;/);
    });

    it('Gmail throws classified errors instead of prose', () => {
      const gmail = strip(readFileSync('server/services/gmail.service.ts', 'utf8'));
      expect(gmail).toContain("classifyResponse(res, { provider: \"gmail\", operation: \"sendEmail\" })");
      expect(gmail).not.toContain('throw new Error(`Failed to send email via Gmail API');
    });

    it('the Gmail refresh flow exists and is reachable', () => {
      const gmail = strip(readFileSync('server/services/gmail.service.ts', 'utf8'));
      expect(gmail).toContain('async refreshAccessToken()');
      expect(gmail).toContain('grant_type: "refresh_token"');
      expect(gmail).toContain('https://oauth2.googleapis.com/token');
    });

    it('reads no longer return empty on failure — silence is not emptiness', () => {
      const gmail = strip(readFileSync('server/services/gmail.service.ts', 'utf8'));
      expect(gmail).toContain('operation: "getHistory"');
      expect(gmail).not.toMatch(/Failed to fetch Gmail history[\s\S]{0,80}?return \[\]/);
    });

    it('adapter contracts exist — S41 measured zero `interface *Provider` hits repo-wide', () => {
      const contracts = readFileSync('server/providers/types.ts', 'utf8');
      for (const name of ['EmailProvider', 'CalendarProvider', 'ProviderAdapter', 'RefreshableCredential']) {
        expect(contracts).toContain(`interface ${name}`);
      }
      // Availability is three-valued on purpose: a free/busy check that cannot reach the
      // provider must not be able to say "FREE".
      expect(contracts).toContain("export type Availability = 'FREE' | 'BUSY' | 'UNKNOWN';");
    });

    it('GmailService declares the contract, and the compiler checks it', () => {
      const gmail = strip(readFileSync('server/services/gmail.service.ts', 'utf8'));
      expect(gmail).toContain('implements EmailProvider, RefreshableCredential');
      expect(gmail).toContain("readonly providerName = 'gmail'");
      expect(gmail).toContain("requiredCapabilities: readonly Capability[] = ['EMAIL_SEND']");
      // Verified by mutation: renaming `providerName` makes `tsc` fail with TS2420, so this is
      // a checked claim rather than a declaration nobody enforces.
    });

    it('the OAuth record stores scopes and a refresh token', () => {
      const server = strip(readFileSync('server/routes/integrations.routes.ts', 'utf8'));
      expect(server).toContain('scopes: recordedScopes');
      expect(server).toContain('refreshToken:');
    });

    it('the calendar adapter judges hours in the meeting’s zone, not in UTC', () => {
      const gateway = strip(readFileSync('server/gateway/actionGateway.ts', 'utf8'));
      expect(gateway).toContain('isWithinBusinessHours(startInstant, { ...DEFAULT_BUSINESS_HOURS, timeZone })');
      expect(gateway).not.toContain('const hour = date.getUTCHours()');
      // The conflict check that could never find a conflict.
      expect(gateway).not.toContain('let hasConflict = false;');
    });
  });
});
