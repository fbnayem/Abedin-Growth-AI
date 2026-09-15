import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE NOTICE EXECUTOR, EXERCISED RATHER THAN READ (§C, §32).
 *
 * `article14Notice.invariant` mocks the gateway, so it proves what the SERVICE does. This file
 * proves what the GATEWAY does, which is the half that matters in a race: the service checks
 * suppression and idempotency from a read, and then the world moves. The gateway is the last
 * thing before the message leaves, and its checks are the ones that are still true at that
 * moment.
 *
 * It exists because a mutation run found the gap. Turning the gateway's suppression branch into
 * `if (false)` left every test in the repository green — the service's own check caught the
 * same case first, so nothing exercised the one that runs last. A guard that is only reachable
 * when another guard has already failed is a guard nothing is testing.
 */

let storeAvailable = true;
let contactDoc: Record<string, unknown> | null = null;
let oauthDocs: Record<string, unknown>[] = [];
let realActionsEnabled = true;
let sendEmailCalls: unknown[] = [];

vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any, ...constraints: any[]) => ({ ...ref, constraints }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (_db: unknown, path: string, id: string) => ({ kind: 'document', path, id }),
  getDoc: async () => ({ exists: () => contactDoc !== null, data: () => contactDoc ?? undefined }),
  getDocs: async () => ({
    empty: oauthDocs.length === 0,
    docs: oauthDocs.map((d) => ({ data: () => d, ref: {} })),
    size: oauthDocs.length,
    forEach: (fn: (d: { data: () => unknown }) => void) => {
      for (const d of oauthDocs) fn({ data: () => d });
    },
  }),
  addDoc: async (ref: any) => ({ kind: 'document', path: ref?.path ?? '', id: 'evt' }),
  setDoc: async () => undefined,
  updateDoc: async () => undefined,
  runTransaction: async (_h: unknown, body: any) =>
    body({ get: async () => ({ exists: () => false, data: () => undefined }), set: async () => undefined }),
}));

vi.mock('../build/schemaCompatibility', () => ({
  schemaCompatibility: async () => ({ state: 'MATCHED', expected: 1, applied: 1, detail: 'mocked' }),
  schemaPermitsIrreversibleActions: (c: any) => c.state === 'MATCHED',
}));

vi.mock('../config/safeMode', () => ({
  isRealActionEnabled: () => realActionsEnabled,
  isFullySafeMode: () => !realActionsEnabled,
  isGenerationEnabled: () => false,
  safeModeSnapshot: () => ({}),
}));

vi.mock('../services/gmail.service', () => ({
  gmailService: {
    setCredentials: () => undefined,
    sendEmail: async (input: unknown) => {
      sendEmailCalls.push(input);
      return { messageId: 'prov-real-1', threadId: 't1' };
    },
  },
  GmailService: class {},
}));

const { ActionGateway, ActionType } = await import('../gateway/actionGateway');

const EMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

function request(payload: Record<string, unknown> = {}) {
  return {
    actionType: ActionType.PRIVACY_NOTICE_SEND,
    organizationId: 'org_1',
    targetId: 'contact_1',
    proposedBy: 'ops@abedin.example',
    payload: {
      contactId: 'contact_1',
      to: 'info@analytical.example',
      subject: 'How we obtained your contact details',
      textBody: 'A long enough body to be a real notice. '.repeat(10),
      htmlBody: '<p>A long enough body to be a real notice.</p>',
      idempotencyKey: 'a14:org_1:contact_1:lia_1',
      ...payload,
    },
  } as any;
}

beforeEach(() => {
  storeAvailable = true;
  realActionsEnabled = true;
  sendEmailCalls = [];
  process.env.UNSUBSCRIBE_SECRET = 'a-secret-long-enough-for-the-minimum-length-check';
  process.env.APP_URL = 'https://app.abedin.example';
  process.env.OUTBOUND_MESSAGE_ID_DOMAIN = 'abedin.example';
  oauthDocs = [
    { provider: 'gmail', scopes: [EMAIL_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'real-token' },
  ];
  contactDoc = {
    id: 'contact_1',
    email: 'info@analytical.example',
    country: 'GB',
    // Deliberately carries NO lawful basis and NO notice. That is the whole point: this is the
    // message that creates the basis, so it must work on a record the ordinary gate refuses.
  };
});

describe('1. the notice reaches a contact the ordinary send gate would refuse', () => {
  it('sends, even though this contact has no lawful basis at all', async () => {
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(true);
    expect(sendEmailCalls.length).toBe(1);
    // The circularity this action type exists to break: EMAIL_SEND to the same record refuses.
    const marketing = await new ActionGateway().dispatchAction({
      ...request(),
      actionType: ActionType.EMAIL_SEND,
      conversationId: 'conv_1',
    });
    // Refused — on the sender-identity check, which runs first in that path. Which check
    // catches it is not the point; that the same record is unsendable as marketing and
    // sendable as a notice is.
    expect(marketing.success).toBe(false);
    expect(sendEmailCalls.length).toBe(1);
  });

  it('carries a working opt-out, because a notice that says you can object must let you', async () => {
    await new ActionGateway().dispatchAction(request());
    expect((sendEmailCalls[0] as any).unsubscribeUrl).toContain('https://app.abedin.example');
  });

  it('uses a Message-ID derived from the idempotency key, so a timeout is answerable', async () => {
    await new ActionGateway().dispatchAction(request());
    const first = (sendEmailCalls[0] as any).rfc822MessageId;
    sendEmailCalls = [];
    await new ActionGateway().dispatchAction(request());
    expect((sendEmailCalls[0] as any).rfc822MessageId).toBe(first);
  });
});

describe('2. and still refuses everything it should', () => {
  it('REFUSES A SUPPRESSED RECIPIENT — the check a mutation run found untested', async () => {
    for (const flag of ['suppressed', 'unsubscribed', 'hardBounced', 'complained']) {
      contactDoc = { id: 'contact_1', email: 'info@analytical.example', [flag]: true };
      sendEmailCalls = [];
      const result = await new ActionGateway().dispatchAction(request());
      expect(result.success, flag).toBe(false);
      expect(result.errorCode, flag).toBe('POLICY_BLOCKED');
      expect(result.blockedReason, flag).toContain('suppressed');
      expect(sendEmailCalls.length, flag).toBe(0);
    }
  });

  it('refuses a bounced address, which cannot receive it anyway', async () => {
    contactDoc = { id: 'contact_1', email: 'info@analytical.example', emailStatus: 'BOUNCED' };
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(sendEmailCalls.length).toBe(0);
  });

  it('REFUSES A SECOND NOTICE, checked here as well as in the service, because of the race', async () => {
    contactDoc = {
      id: 'contact_1',
      email: 'info@analytical.example',
      article14NoticeSentAt: '2026-08-01T09:00:00.000Z',
    };
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('already sent');
    expect(sendEmailCalls.length).toBe(0);
  });

  it('refuses a contact that does not exist', async () => {
    contactDoc = null;
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(sendEmailCalls.length).toBe(0);
  });

  it('refuses when no contactId was supplied, so suppression could not be checked', async () => {
    const result = await new ActionGateway().dispatchAction(request({ contactId: undefined }));
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('POLICY_BLOCKED');
    expect(sendEmailCalls.length).toBe(0);
  });

  it('refuses an empty body rather than sending a legal notice with a blank line in it', async () => {
    for (const gap of [{ textBody: '' }, { htmlBody: '   ' }, { subject: '' }, { to: '' }]) {
      sendEmailCalls = [];
      const result = await new ActionGateway().dispatchAction(request(gap));
      expect(result.success, JSON.stringify(gap)).toBe(false);
      expect(sendEmailCalls.length).toBe(0);
    }
  });

  it('refuses while the send flag is off', async () => {
    realActionsEnabled = false;
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(result.blockedReason).toContain('Safe Rebuild Mode');
    expect(sendEmailCalls.length).toBe(0);
  });

  it('refuses a placeholder credential rather than reporting a notice that never went out', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [EMAIL_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'mock_token' }];
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
    expect(sendEmailCalls.length).toBe(0);
  });

  it('REFUSES WHEN NO OPT-OUT LINK CAN BE BUILT — found by a mutation run', () => {
    // The notice tells people they can object. A message that says so while offering no
    // mechanical way to do it is the compliance theatre this repository keeps deleting, and it
    // is also what makes the suppression check above reachable for somebody never contacted
    // before. Removing this branch left every other test green: the happy path builds a URL
    // fine, so nothing exercised the branch that runs when it cannot.
    return (async () => {
      for (const broken of [{ UNSUBSCRIBE_SECRET: 'short' }, { APP_URL: 'not-a-url' }]) {
        const saved: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(broken)) {
          saved[k] = process.env[k];
          process.env[k] = v;
        }
        sendEmailCalls = [];
        try {
          const result = await new ActionGateway().dispatchAction(request());
          expect(result.success, JSON.stringify(broken)).toBe(false);
          expect(result.errorCode, JSON.stringify(broken)).toBe('POLICY_BLOCKED');
          expect(result.blockedReason, JSON.stringify(broken)).toContain('opt out');
          expect(sendEmailCalls.length, JSON.stringify(broken)).toBe(0);
        } finally {
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      }
    })();
  });

  it('refuses when no stable Message-ID can be minted, before the network', async () => {
    delete process.env.OUTBOUND_MESSAGE_ID_DOMAIN;
    const result = await new ActionGateway().dispatchAction(request());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('UNRECONCILABLE_SEND');
    expect(sendEmailCalls.length).toBe(0);
  });
});
