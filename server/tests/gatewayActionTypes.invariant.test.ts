import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * INVARIANTS FOR EVERY DECLARED ACTION TYPE (S25/§C).
 *
 * `ActionType` declared eight when this suite was written. The execution switch implemented two
 * and sent the other six to `default: { success: false, error: 'Unsupported action type' }`.
 *
 * P6c added a ninth, PRIVACY_NOTICE_SEND, and the `never` check below did exactly what it
 * exists for: adding the type without classifying it was a compile error, not a runtime
 * surprise. It is implemented, so it joins EMAIL_SEND and CALENDAR_CREATE in the implemented
 * set rather than in UNIMPLEMENTED.
 *
 * That refusal carried no `errorCode`, so the outbox worker fell through to its `else` branch,
 * threw, and RETRIED — backoff after backoff for an action type that cannot succeed by being
 * attempted again. It named nothing, so a queue full of them said only "Unsupported action type".
 * And `isIrreversible`, `providerFor` and `capabilityFor` all carry full branches for those six, so
 * every other part of the gateway reads as though they are supported.
 *
 * Nothing dispatches them today: `EMAIL_SEND` from the outbox worker and `CALENDAR_CREATE` from
 * POST /api/meetings are the only two dispatch sites in the repository. So this suite is about what
 * happens the day somebody adds another — and about the `never` check that makes an
 * unclassified type a compile error rather than a runtime message.
 */

let storeAvailable = true;
let oauthDocs: Record<string, unknown>[] = [];
let realActionsEnabled = true;
let sendEmailCalls: unknown[] = [];
let createEventCalls: unknown[] = [];

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
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
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
      throw new Error('no test here should reach a provider');
    },
  },
  GmailService: class {},
}));

vi.mock('../services/calendar.service', () => ({
  calendarService: {
    setCredentials: () => undefined,
    checkAvailability: async () => ({ availability: 'FREE', reason: 'stub' }),
    createEvent: async (input: unknown) => {
      createEventCalls.push(input);
      return { eventId: 'goog-evt-types-1', conferenceUrl: null };
    },
  },
  GoogleCalendarService: class {},
  CalendarService: class {},
}));

const { ActionGateway, ActionType } = await import('../gateway/actionGateway');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** The six with no executor. */
const UNIMPLEMENTED = [
  'CALENDAR_UPDATE',
  'CALENDAR_CANCEL',
  'PAYMENT_CREATE',
  'SIGNATURE_SEND',
  'CRM_UPDATE',
  'EXTERNAL_MESSAGE_SEND',
];

/** The three with an executor. PRIVACY_NOTICE_SEND joined them in P6c. */
const IMPLEMENTED = ['EMAIL_SEND', 'CALENDAR_CREATE', 'PRIVACY_NOTICE_SEND'];

function request(actionType: string) {
  return {
    actionType,
    organizationId: 'org_1',
    targetId: 'contact_1',
    proposedBy: 'test',
    payload: {
      title: 'x',
      startTime: '2026-09-14T10:00:00.000Z',
      endTime: '2026-09-14T10:30:00.000Z',
      timezone: 'Europe/London',
      attendees: [],
      idempotencyKey: 'org_1:contact_1:1',
    },
  } as any;
}

beforeEach(() => {
  storeAvailable = true;
  realActionsEnabled = true;
  sendEmailCalls = [];
  createEventCalls = [];
  oauthDocs = [
    { provider: 'gmail', scopes: [CALENDAR_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'real-token' },
  ];
});

describe('1. every declared type is accounted for', () => {
  it('there are nine, and the suite covers all of them', () => {
    // A list that drifts from the enum would quietly stop testing a type. The count is asserted
    // as well as the membership, so ADDING a type fails here rather than passing because the
    // new name happened to be absent from both lists.
    const declared = Object.values(ActionType) as string[];
    expect(declared.length).toBe(9);
    expect([...UNIMPLEMENTED, ...IMPLEMENTED].sort()).toEqual([...declared].sort());
  });

  it('no declared type produces the old anonymous refusal', async () => {
    for (const actionType of Object.values(ActionType) as string[]) {
      const result = await new ActionGateway().dispatchAction(request(actionType));
      expect(result.error ?? '', actionType).not.toBe('Unsupported action type');
    }
  });
});

describe('2. an unimplemented type refuses by name, and terminally', () => {
  for (const actionType of UNIMPLEMENTED) {
    it(`${actionType} is refused with UNSUPPORTED_ACTION`, async () => {
      const result = await new ActionGateway().dispatchAction(request(actionType));

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('UNSUPPORTED_ACTION');
      // Named, so a queue of them says which one.
      expect(result.error).toContain(actionType);
    });
  }

  it('and no provider is touched by any of them', async () => {
    for (const actionType of UNIMPLEMENTED) {
      await new ActionGateway().dispatchAction(request(actionType));
    }
    expect(sendEmailCalls.length).toBe(0);
    expect(createEventCalls.length).toBe(0);
  });

  it('the worker treats it as terminal rather than retrying to exhaustion', () => {
    // Comments are stripped first. The explanation beside this branch is longer than the branch,
    // so a fixed window over the raw text measured the comment and stopped before the call — which
    // is how this assertion failed on its first run against correct code.
    const worker = readFileSync('server/workers/outbox.worker.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const branch = worker.slice(worker.indexOf("result.errorCode === 'UNSUPPORTED_ACTION'"));

    // The fourth argument is the terminal flag. Without it the job retries to exhaustion for an
    // action type that has no executor and cannot acquire one by being attempted again.
    expect(branch.slice(0, 300)).toMatch(/markFailed\([^)]*true\)/);
  });
});

describe('3. the two that are implemented still execute', () => {
  it('CALENDAR_CREATE reaches the calendar adapter', async () => {
    // The other half: a switch that refused everything would satisfy section 2 completely.
    const result = await new ActionGateway().dispatchAction(request('CALENDAR_CREATE'));
    expect(createEventCalls.length).toBe(1);
    expect(result.success).toBe(true);
  });

  it('EMAIL_SEND reaches its executor rather than the refusal', async () => {
    const result = await new ActionGateway().dispatchAction(request('EMAIL_SEND'));
    // It refuses later, for a reason of its own — no contactId — which is not this refusal.
    expect(result.errorCode).not.toBe('UNSUPPORTED_ACTION');
  });
});

describe('4. a ninth type would be a compile error, not a runtime message', () => {
  it('the switch ends in a `never` exhaustiveness check', () => {
    const source = readFileSync('server/gateway/actionGateway.ts', 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

    expect(code).toContain('const unclassified: never = request.actionType;');
    expect(code).not.toContain("result = { success: false, error: 'Unsupported action type' };");
  });

  it('that check would catch the anonymous default coming back', () => {
    const regressed = "default:\n  result = { success: false, error: 'Unsupported action type' };";
    expect(regressed).toContain("result = { success: false, error: 'Unsupported action type' };");
  });
});
