import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * P1.11 — behavioural tests for the capability pre-flight.
 *
 * These exist because mutation testing found the source-text assertions insufficient. Two
 * mutations survived a suite that asserted the pre-flight's CODE was present and appeared before
 * the dispatch switch:
 *
 *   - wrapping the call in `if (false && …)` — the text still matched, in the right order;
 *   - making a datastore failure return `null` (a pass) — no test exercised that branch at all.
 *
 * Asserting that a call site exists is not asserting that it runs. It is the same distinction
 * P1.8 recorded for the sanitiser that was in the repository and called by nothing, and the same
 * one that let the §32 classifier sit in the codebase for months while classifying every real
 * timeout as a definite failure.
 */

// ---------------------------------------------------------------------------
// Datastore double. `oauthDocs` is what a query over oauth_connections returns.
// ---------------------------------------------------------------------------
let oauthDocs: Record<string, unknown>[] = [];
let queryShouldThrow = false;
let storeAvailable = true;


/**
 * Safe Mode is mocked rather than switched on via the environment.
 *
 * To prove the pre-flight RUNS, a request has to get past the feature-flag gate — and the whole
 * point of that gate is that real sends are off (addendum §A). Mocking the accessor lets the
 * request reach the pre-flight inside this process while `.env` stays untouched and no code path
 * to a real provider is ever enabled. The gmail service is stubbed as a second layer: if the
 * pre-flight ever failed to refuse, the test fails loudly instead of attempting a network call.
 */
let realActionsEnabled = false;
/**
 * The schema-compatibility gate is mocked to MATCHED.
 *
 * S48 added a check that refuses every irreversible action unless the database reports the same
 * number of applied migrations as this build carries. The datastore double here has no
 * migrations table, so the real check answers UNKNOWN and — correctly — refuses everything,
 * which would make every assertion in this file pass for the wrong reason.
 *
 * That check has its own file (`schemaCompatibility.invariant.test.ts`), including the
 * assertion that the gateway consults it before dispatching. This file is about a different
 * subject, and mocking it here states that rather than leaving a second gate silently deciding
 * the outcome.
 */
vi.mock('../build/schemaCompatibility', () => ({
  schemaCompatibility: async () => ({
    state: 'MATCHED',
    expected: 1,
    applied: 1,
    detail: 'mocked for this suite',
  }),
  schemaPermitsIrreversibleActions: (c: any) => c.state === 'MATCHED',
}));

vi.mock('../config/safeMode', () => ({
  isRealActionEnabled: () => realActionsEnabled,
  isFullySafeMode: () => !realActionsEnabled,
  safeModeSnapshot: () => ({}),
}));

vi.mock('../services/gmail.service', () => ({
  gmailService: {
    setCredentials: () => undefined,
    sendEmail: async () => {
      throw new Error(
        'A send was attempted. The capability pre-flight was supposed to refuse before this.'
      );
    },
  },
  GmailService: class {},
}));

vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any, ..._rest: unknown[]) => ref,
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  orderBy: () => ({}),
  limit: () => ({}),
  getDocs: async (_ref: any) => {
    if (queryShouldThrow) throw new Error('datastore unavailable');
    return {
      empty: oauthDocs.length === 0,
      docs: oauthDocs.map((d) => ({ data: () => d, ref: {} })),
      forEach: (fn: (d: { data: () => unknown }) => void) => {
        for (const d of oauthDocs) fn({ data: () => d });
      },
    };
  },
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
  addDoc: async () => ({ id: 'new' }),
  setDoc: async () => undefined,
  updateDoc: async () => undefined,
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}` }),
  serverTimestamp: () => new Date(),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}));

const { ActionGateway, ActionType, isIrreversible, capabilityFor, providerFor } = await import(
  '../gateway/actionGateway'
);

const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function request(actionType = ActionType.EMAIL_SEND) {
  return {
    actionType,
    organizationId: 'org_1',
    targetId: 'contact_1',
    payload: { to: 'someone@example.com', subject: 'x', htmlBody: '<p>x</p>' },
  } as any;
}

/** Reach the private pre-flight directly: it is the unit whose behaviour is at stake. */
function preflight(gateway: any, actionType = ActionType.EMAIL_SEND) {
  const capability = capabilityFor(actionType);
  return gateway.checkProviderCapability(request(actionType), capability);
}

describe('P1.11 — the capability pre-flight actually runs and actually refuses', () => {
  let gateway: any;

  beforeEach(() => {
    oauthDocs = [];
    queryShouldThrow = false;
    storeAvailable = true;
    realActionsEnabled = false;
    gateway = new ActionGateway();
  });

  it('a connection with the send scope passes', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE', expiresAt: null }];
    expect(await preflight(gateway)).toBeNull();
  });

  it('a READONLY connection is refused, and the refusal never reaches the network', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [READ_SCOPE], status: 'ACTIVE', expiresAt: null }];
    const result = await preflight(gateway);
    expect(result).not.toBeNull();
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
    expect(result.error).toContain('EMAIL_SEND');
  });

  it('a connection with NO recorded scopes is refused — the state every existing record is in', async () => {
    oauthDocs = [{ provider: 'gmail', status: 'ACTIVE', expiresAt: null }];
    const result = await preflight(gateway);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
    expect(result.error).toContain('Reconnect');
  });

  it('Google’s space-delimited scope string is understood', async () => {
    oauthDocs = [{ provider: 'gmail', scope: `${READ_SCOPE} ${SEND_SCOPE}`, status: 'ACTIVE' }];
    expect(await preflight(gateway)).toBeNull();
  });

  it('no connection at all is PROVIDER_NOT_CONFIGURED, which is a different problem', async () => {
    oauthDocs = [];
    const result = await preflight(gateway);
    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('a connection for another provider does not satisfy a Gmail send', async () => {
    oauthDocs = [{ provider: 'slack', scopes: [SEND_SCOPE], status: 'ACTIVE' }];
    const result = await preflight(gateway);
    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('a DATASTORE FAILURE refuses the send — unknown is not permission', async () => {
    // The mutation that survived the source-text suite: returning null here (a pass) meant a
    // transient Firestore error silently granted permission to send.
    oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE' }];
    queryShouldThrow = true;
    const result = await preflight(gateway);
    expect(result).not.toBeNull();
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
    expect(result.error).toContain('unknown');
  });

  it('an unavailable datastore refuses too, rather than assuming the best', async () => {
    storeAvailable = false;
    const result = await preflight(gateway);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
  });

  it('a revoked connection is refused even holding the right scope', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'REVOKED' }];
    const result = await preflight(gateway);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
  });

  it('an expired credential is refused', async () => {
    oauthDocs = [
      { provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) },
    ];
    const result = await preflight(gateway);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
  });

  it('a calendar action needs CALENDAR_WRITE, which a send scope does not give', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE' }];
    const result = await preflight(gateway, ActionType.CALENDAR_CREATE);
    expect(result.errorCode).toBe('CAPABILITY_NOT_GRANTED');
    expect(result.error).toContain('CALENDAR_WRITE');
  });

  it('a calendar scope satisfies a calendar action', async () => {
    oauthDocs = [
      { provider: 'gmail', scopes: ['https://www.googleapis.com/auth/calendar.events'], status: 'ACTIVE' },
    ];
    expect(await preflight(gateway, ActionType.CALENDAR_CREATE)).toBeNull();
  });

  it('CRM_UPDATE needs no provider capability, so the pre-flight does not apply', () => {
    expect(capabilityFor(ActionType.CRM_UPDATE)).toBeNull();
  });

  // -------------------------------------------------------------------------
  describe('dispatchAction consults the pre-flight — the call site, not just the helper', () => {
    /**
     * The surviving mutation wrapped the call site in `if (false && …)`. Every source-text
     * assertion still passed, because the text was still there in the right order. Only going
     * through `dispatchAction` can tell the difference.
     */
    beforeEach(() => {
      realActionsEnabled = true;
    });

    it('a READONLY connection is refused by dispatchAction, before any provider call', async () => {
      oauthDocs = [{ provider: 'gmail', scopes: [READ_SCOPE], status: 'ACTIVE' }];
      const result = await gateway.dispatchAction(request());
      expect(result.success).toBe(false);
      // If the pre-flight were skipped, the mocked gmailService would throw instead.
      expect(result.errorCode ?? result.blockedReason).toBeDefined();
      expect(JSON.stringify(result)).toContain('EMAIL_SEND');
    });

    it('a connection with no recorded scopes is refused by dispatchAction', async () => {
      oauthDocs = [{ provider: 'gmail', status: 'ACTIVE' }];
      const result = await gateway.dispatchAction(request());
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain('Reconnect');
    });

    it('a datastore failure during dispatch refuses the send', async () => {
      oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE' }];
      queryShouldThrow = true;
      const result = await gateway.dispatchAction(request());
      expect(result.success).toBe(false);
    });

    it('Safe Mode still blocks first when real actions are off', async () => {
      realActionsEnabled = false;
      oauthDocs = [{ provider: 'gmail', scopes: [SEND_SCOPE], status: 'ACTIVE' }];
      const result = await gateway.dispatchAction(request());
      expect(result.success).toBe(false);
      expect(result.blockedReason).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('the maps the §32 gate depends on', () => {
    it('every side-effecting action is irreversible; only the internal write is not', () => {
      for (const type of [
        ActionType.EMAIL_SEND,
        ActionType.CALENDAR_CREATE,
        ActionType.CALENDAR_UPDATE,
        ActionType.CALENDAR_CANCEL,
        ActionType.PAYMENT_CREATE,
        ActionType.SIGNATURE_SEND,
        ActionType.EXTERNAL_MESSAGE_SEND,
      ]) {
        expect(isIrreversible(type)).toBe(true);
      }
      expect(isIrreversible(ActionType.CRM_UPDATE)).toBe(false);
    });

    it('an ActionType nobody classified is treated as irreversible', () => {
      // Adding an enum member without deciding its posture must not make it freely retryable.
      expect(isIrreversible('SOMETHING_NEW' as any)).toBe(true);
    });

    it('each action names the provider it talks to', () => {
      expect(providerFor(ActionType.EMAIL_SEND)).toBe('gmail');
      expect(providerFor(ActionType.CALENDAR_CREATE)).toBe('google-calendar');
      expect(providerFor(ActionType.PAYMENT_CREATE)).toBe('stripe');
      expect(providerFor(ActionType.CRM_UPDATE)).toBe('internal');
    });
  });
});
