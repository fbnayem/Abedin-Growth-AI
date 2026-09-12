import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { SenderPosture } from '../domain/senderIdentity';

/**
 * THE GATEWAY REFUSES TO SEND FROM A DOMAIN THAT CANNOT BE BELIEVED (S27).
 *
 * The capability pre-flight already answers "may this connection perform EMAIL_SEND" from the
 * connection's scopes and status. It now also asks whether the connection's domain is set up to
 * authenticate what it sends. MISSING is refused; UNKNOWN — the records could not be looked up —
 * is refused too, because unknown is not permission (§14); WEAK proceeds with a warning; READY
 * proceeds. The pre-flight is called here directly, the way the scope refusals are tested, with
 * the deliverability service replaced by a posture under test and every other seam mocked as
 * capabilityPreflight.invariant mocks it.
 */

let oauthDocs: Record<string, unknown>[] = [];
let posture: SenderPosture | null = null;
let postureCalls: string[] = [];

vi.mock('../build/schemaCompatibility', () => ({
  schemaCompatibility: async () => ({ state: 'MATCHED', expected: 1, applied: 1, detail: 'mocked' }),
  schemaPermitsIrreversibleActions: (c: any) => c.state === 'MATCHED',
}));
vi.mock('../config/safeMode', () => ({
  isRealActionEnabled: () => false,
  isFullySafeMode: () => true,
  safeModeSnapshot: () => ({}),
}));
vi.mock('../services/gmail.service', () => ({
  gmailService: { setCredentials: () => undefined, sendEmail: async () => { throw new Error('a send was attempted'); } },
  GmailService: class {},
}));
vi.mock('../services/deliverability.service', () => ({
  senderPostureFor: async (domain: string) => {
    postureCalls.push(domain);
    if (posture === null) throw new Error('no posture configured for this test');
    return { posture, checkedAt: '2026-09-12T00:00:00.000Z', cached: false };
  },
}));
vi.mock('../store', () => ({
  get store() {
    return {};
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any) => ref,
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  orderBy: () => ({}),
  limit: () => ({}),
  getDocs: async () => ({
    empty: oauthDocs.length === 0,
    docs: oauthDocs.map((d) => ({ data: () => d, ref: {} })),
    forEach: (fn: (d: { data: () => unknown }) => void) => {
      for (const d of oauthDocs) fn({ data: () => d });
    },
  }),
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
  addDoc: async () => ({ id: 'new' }),
  setDoc: async () => undefined,
  updateDoc: async () => undefined,
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}` }),
  serverTimestamp: () => new Date(),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}));

const { ActionGateway, ActionType, capabilityFor } = await import('../gateway/actionGateway');

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const connection = (over: Record<string, unknown> = {}) => ({
  provider: 'gmail',
  scopes: [SEND_SCOPE],
  status: 'ACTIVE',
  expiresAt: null,
  accountEmail: 'ops@example.co.uk',
  accessToken: 'ya29.not-a-placeholder',
  ...over,
});
const verdict = (v: SenderPosture['verdict'], reasons: string[] = []): SenderPosture => ({
  domain: 'example.co.uk',
  spf: { state: 'PRESENT', policy: 'softfail', detail: '' },
  dkim: { state: 'PRESENT', policy: 'google', detail: '' },
  dmarc: { state: 'PRESENT', policy: 'reject', detail: '' },
  verdict: v,
  reasons,
});
const request = (actionType = ActionType.EMAIL_SEND) =>
  ({ actionType, organizationId: 'org_1', targetId: 'contact_1', payload: { to: 'x@example.com', subject: 'x', htmlBody: '<p>x</p>' } }) as any;

let gateway: any;
const preflight = (actionType = ActionType.EMAIL_SEND) => gateway.checkProviderCapability(request(actionType), capabilityFor(actionType));

beforeEach(() => {
  oauthDocs = [connection()];
  posture = null;
  postureCalls = [];
  gateway = new ActionGateway();
});

// =============================================================================================
describe('1. the pre-flight consults the sending domain, after the scopes', () => {
  it('THE INVARIANT — a MISSING posture is refused with its reasons and where to look', async () => {
    posture = verdict('MISSING', ['SPF MISSING: no TXT record beginning v=spf1']);
    const result = await preflight();
    expect(result).not.toBeNull();
    expect(result.errorCode).toBe('SENDER_IDENTITY_UNVERIFIED');
    expect(result.error).toContain('example.co.uk is MISSING');
    expect(result.error).toContain('no TXT record beginning v=spf1');
    expect(result.error).toContain('/api/deliverability');
    expect(postureCalls).toEqual(['example.co.uk']);
  });

  it('an UNKNOWN posture is refused too: not looked up is not permission', async () => {
    posture = verdict('UNKNOWN', ['SPF lookup failed: ETIMEOUT']);
    const result = await preflight();
    expect(result.errorCode).toBe('SENDER_IDENTITY_UNVERIFIED');
    expect(result.error).toContain('UNKNOWN');
  });

  it('a WEAK posture proceeds', async () => {
    posture = verdict('WEAK', ['DMARC p=none']);
    expect(await preflight()).toBeNull();
  });

  it('a READY posture proceeds', async () => {
    posture = verdict('READY');
    expect(await preflight()).toBeNull();
    expect(postureCalls).toEqual(['example.co.uk']);
  });

  it('the domain judged is the connected account\'s, lowercased', async () => {
    oauthDocs = [connection({ accountEmail: 'Ops@Sub.Example.CO.UK' })];
    posture = verdict('READY');
    await preflight();
    expect(postureCalls).toEqual(['sub.example.co.uk']);
  });
});

// =============================================================================================
describe('2. what cannot be judged is refused', () => {
  it('a connection with no account email has no domain to check', async () => {
    oauthDocs = [connection({ accountEmail: undefined })];
    const result = await preflight();
    expect(result.errorCode).toBe('SENDER_IDENTITY_UNVERIFIED');
    expect(result.error).toContain('no usable domain');
    expect(postureCalls).toEqual([]);
  });

  it('a posture service that throws is a refusal, not a pass', async () => {
    posture = null; // the mock throws
    const result = await preflight();
    expect(result.errorCode).toBe('SENDER_IDENTITY_UNVERIFIED');
    expect(result.error).toContain('could not be checked');
  });

  it('the scope refusal still comes first: a connection that may not send is not asked about DNS', async () => {
    oauthDocs = [connection({ scopes: ['https://www.googleapis.com/auth/gmail.readonly'] })];
    posture = verdict('READY');
    const result = await preflight();
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
    expect(postureCalls).toEqual([]);
  });
});

// =============================================================================================
describe('3. only mail is judged on mail identity', () => {
  it('a calendar action does not consult the sending domain', async () => {
    oauthDocs = [connection({ scopes: ['https://www.googleapis.com/auth/calendar'] })];
    posture = verdict('MISSING');
    const result = await preflight(ActionType.CALENDAR_CREATE);
    expect(result === null || result.errorCode !== 'SENDER_IDENTITY_UNVERIFIED').toBe(true);
    expect(postureCalls).toEqual([]);
  });
});

// =============================================================================================
describe('4. the refusal code exists in the vocabulary, and the pre-flight is where the check lives', () => {
  const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
  it('SENDER_IDENTITY_UNVERIFIED is a declared error code', () => {
    const union = gateway.slice(gateway.indexOf('errorCode?:'), gateway.indexOf(';', gateway.indexOf('errorCode?:')));
    expect(union).toContain("| 'SENDER_IDENTITY_UNVERIFIED'");
  });
  it('the check runs inside checkProviderCapability, after assertCapability', () => {
    const at = gateway.indexOf('private async checkProviderCapability(');
    const body = gateway.slice(at, gateway.indexOf('private checkFeatureFlag(', at));
    expect(body.indexOf('assertCapability(connection, capability, new Date());')).toBeGreaterThan(-1);
    expect(body.indexOf('this.checkSenderIdentity(')).toBeGreaterThan(body.indexOf('assertCapability(connection, capability, new Date());'));
  });
});
