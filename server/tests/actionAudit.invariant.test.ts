import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  auditSnapshot,
  mustCommitBefore,
  payloadFingerprint,
  stableStringify,
} from '../domain/actionAudit';

/**
 * INVARIANTS FOR THE GATEWAY'S AUDIT TRAIL (S10).
 *
 * `logAction` returned `void` and could not fail: `if (!store) return;` and the whole write inside
 * `catch (e) { console.error(...) }`. So a datastore that was briefly unavailable printed one line
 * and the irreversible action proceeded. The addendum's own remediation names the test this file
 * owes: "audit write fails -> gmailService.sendEmail never invoked".
 *
 * Every lifecycle state was also written to ONE document id with `{ merge: true }`, so DISPATCHING
 * overwrote PROPOSED and SUCCESS overwrote both. What survived was the last status, never the
 * sequence — and the sequence is what an audit trail is.
 *
 * The asymmetry these tests pin: a write BEFORE the side effect may refuse the dispatch, because
 * refusing costs a retry. A write AFTER it may not, because the message is already in someone's
 * inbox and reporting failure would send it twice (§32). The result says `auditRecorded: false`
 * instead of lying in either direction.
 */

let storeAvailable = true;
let oauthDocs: Record<string, unknown>[] = [];
let addedEvents: { path: string; data: any }[] = [];
let setDocPaths: string[] = [];
/** 1-based index of the addDoc call that should throw, or null for none. */
let addDocFailsOnCall: number | null = null;
let realActionsEnabled = true;

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
  getDocs: async (ref: any) => {
    // Faithful enough to matter: the trail query is served from what `addDoc` actually wrote, and
    // the equality constraint is applied, so a reader that forgot its filter would be visible here.
    const path = String(ref?.path ?? '');
    const isTrail = path.includes('actionLogs');
    const rows: any[] = isTrail ? addedEvents.map((e) => e.data) : oauthDocs;
    // Constraints are applied only to the collection under test. The capability pre-flight queries
    // oauth_connections with predicates this fixture does not model, and filtering those out would
    // refuse every dispatch before it reached the audit gates — which is what it did on first run.
    const constraints: any[] = isTrail && Array.isArray(ref?.constraints) ? ref.constraints : [];
    const matching = rows.filter((row) =>
      constraints.every((c) => c?.field === undefined || row?.[c.field] === c.value)
    );
    return {
      empty: matching.length === 0,
      docs: matching.map((d) => ({ data: () => d, ref: {} })),
      size: matching.length,
      forEach: (fn: (d: { data: () => unknown }) => void) => {
        for (const d of matching) fn({ data: () => d });
      },
    };
  },
  addDoc: async (ref: any, data: any) => {
    addedEvents.push({ path: ref?.path ?? '', data });
    if (addDocFailsOnCall !== null && addedEvents.length === addDocFailsOnCall) {
      throw new Error('datastore unavailable');
    }
    return { kind: 'document', path: ref?.path ?? '', id: `evt_${addedEvents.length}` };
  },
  setDoc: async (ref: any) => {
    setDocPaths.push(ref?.path ?? '');
  },
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

let sendEmailCalls: unknown[] = [];
vi.mock('../services/gmail.service', () => ({
  gmailService: {
    setCredentials: () => undefined,
    sendEmail: async (input: unknown) => {
      sendEmailCalls.push(input);
      throw new Error('a send was attempted; the audit gate was supposed to refuse first');
    },
  },
  GmailService: class {},
}));

let createEventCalls: unknown[] = [];
vi.mock('../services/calendar.service', () => ({
  calendarService: {
    setCredentials: () => undefined,
    checkAvailability: async () => ({ availability: 'FREE', reason: 'stub' }),
    createEvent: async (input: unknown) => {
      createEventCalls.push(input);
      return { eventId: 'goog-evt-audit-1', conferenceUrl: null };
    },
  },
  GoogleCalendarService: class {},
  CalendarService: class {},
}));

const { ActionGateway, ActionType } = await import('../gateway/actionGateway');
const { readActionTrail } = await import('../services/actionTrail.service');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

function bookingRequest() {
  return {
    actionType: ActionType.CALENDAR_CREATE,
    organizationId: 'org_1',
    targetId: 'contact_1',
    proposedBy: 'test',
    payload: {
      title: 'Intro call',
      startTime: '2026-09-14T10:00:00.000Z',
      endTime: '2026-09-14T10:30:00.000Z',
      timezone: 'Europe/London',
      attendees: ['buyer@acme.example'],
      idempotencyKey: 'org_1:contact_1:1757325600000:30',
    },
  } as any;
}

function emailRequest() {
  return {
    actionType: ActionType.EMAIL_SEND,
    organizationId: 'org_1',
    targetId: 'contact_1',
    proposedBy: 'test',
    payload: {
      to: 'buyer@acme.example',
      subject: 'Following up',
      htmlBody: '<p>hello</p>',
      contactId: 'contact_1',
      idempotencyKey: 'org_1:contact_1:1',
    },
  } as any;
}

beforeEach(() => {
  storeAvailable = true;
  oauthDocs = [
    { provider: 'gmail', scopes: [CALENDAR_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'real-token' },
  ];
  addedEvents = [];
  setDocPaths = [];
  addDocFailsOnCall = null;
  realActionsEnabled = true;
  sendEmailCalls = [];
  createEventCalls = [];
});

describe('1. a write that precedes the side effect may refuse the dispatch', () => {
  it('THE INVARIANT — the PROPOSED write fails, and no send is attempted', async () => {
    addDocFailsOnCall = 1;
    const result = await new ActionGateway().dispatchAction(emailRequest());

    expect(sendEmailCalls.length).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AUDIT_UNAVAILABLE');
  });

  it('and the refusal is RETRYABLE, not a policy block', async () => {
    // The worker treats `blockedReason` as terminal ("retrying cannot change a policy decision")
    // and dead-letters. A datastore outage is transient: the send has not happened, and the job
    // must come back through backoff rather than being killed.
    addDocFailsOnCall = 1;
    const result = await new ActionGateway().dispatchAction(emailRequest());
    expect(result.blockedReason).toBeUndefined();
    expect(result.error).toMatch(/audit/i);
  });

  it('no datastore at all is the same refusal — this replaces `if (!store) return`', async () => {
    storeAvailable = false;
    const result = await new ActionGateway().dispatchAction(emailRequest());
    expect(sendEmailCalls.length).toBe(0);
    expect(result.errorCode).toBe('AUDIT_UNAVAILABLE');
  });

  it('the DISPATCHING write fails, and the provider is never called', async () => {
    // PROPOSED commits; the write immediately before execution does not.
    addDocFailsOnCall = 2;
    const result = await new ActionGateway().dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('AUDIT_UNAVAILABLE');
  });
});

describe('2. a write that follows the side effect may not undo it', () => {
  it('the action succeeded, the SUCCESS write failed, and the result says so', async () => {
    // Reporting failure here would send the message again (§32). Reporting plain success would
    // claim a record that does not exist. `auditRecorded` is the third answer.
    addDocFailsOnCall = 3;
    const result = await new ActionGateway().dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(result.auditRecorded).toBe(false);
  });

  it('a fully recorded dispatch says the opposite', async () => {
    const result = await new ActionGateway().dispatchAction(bookingRequest());
    expect(result.success).toBe(true);
    expect(result.auditRecorded).not.toBe(false);
  });
});

describe('3. the trail is append-only, and it is a sequence', () => {
  it('every transition adds an event rather than overwriting one', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());

    expect(addedEvents.length).toBeGreaterThanOrEqual(3);
    const statuses = addedEvents.map((e) => e.data.status);
    expect(statuses).toContain('PROPOSED');
    expect(statuses).toContain('DISPATCHING');
    expect(statuses.some((s) => s === 'SUCCESS' || s === 'FAILED')).toBe(true);
  });

  it('nothing is written to actionLogs with setDoc any more', async () => {
    // `setDoc(..., { merge: true })` on one id per action is what destroyed the ordering.
    await new ActionGateway().dispatchAction(bookingRequest());
    expect(setDocPaths.filter((p) => p.includes('actionLogs'))).toEqual([]);
  });

  it('the events share one actionId and carry an increasing sequence', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());

    const ids = new Set(addedEvents.map((e) => e.data.actionId));
    expect(ids.size).toBe(1);
    const seqs = addedEvents.map((e) => e.data.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('and they are written under the tenant path', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());
    for (const event of addedEvents) {
      expect(event.path).toContain('organizations/org_1');
      expect(event.data.organizationId).toBe('org_1');
    }
  });
});

describe('4. the payload is fingerprinted, never copied', () => {
  it('each event carries a digest', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());
    for (const event of addedEvents) {
      expect(String(event.data.payloadFingerprint)).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('and the recipient and content are not in the record', async () => {
    // An audit trail that copies the message body creates a second place a person's data lives,
    // and a second place it has to be erased from.
    await new ActionGateway().dispatchAction(bookingRequest());
    const rendered = JSON.stringify(addedEvents);
    expect(rendered).not.toContain('buyer@acme.example');
    expect(rendered).not.toContain('Intro call');
  });

  it('the idempotency key is recorded, so retries correlate', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());
    expect(addedEvents[0].data.idempotencyKey).toBe('org_1:contact_1:1757325600000:30');
  });
});

describe('5. the pure parts', () => {
  it('only the statuses that precede the side effect must commit', () => {
    expect(mustCommitBefore('PROPOSED')).toBe(true);
    expect(mustCommitBefore('DISPATCHING')).toBe(true);
    for (const after of ['SUCCESS', 'FAILED', 'ERROR', 'BLOCKED', 'AMBIGUOUS_PROVIDER_RESULT', 'RECONCILED_APPLIED']) {
      expect(mustCommitBefore(after), after).toBe(false);
    }
  });

  it('the fingerprint does not depend on key order', () => {
    expect(payloadFingerprint({ a: 1, b: 2 })).toBe(payloadFingerprint({ b: 2, a: 1 }));
    expect(payloadFingerprint({ a: 1 })).not.toBe(payloadFingerprint({ a: 2 }));
  });

  it('and it is stable across calls and total over hostile values', () => {
    const cyclic: any = { name: 'x' };
    cyclic.self = cyclic;
    expect(() => payloadFingerprint(cyclic)).not.toThrow();
    expect(payloadFingerprint(cyclic)).toBe(payloadFingerprint(cyclic));
    expect(() => payloadFingerprint({ big: BigInt(1), fn: () => 1, und: undefined })).not.toThrow();
  });

  it('stableStringify drops undefined and sorts keys, as JSON does not', () => {
    expect(stableStringify({ b: 1, a: undefined, c: 2 })).toBe('{"b":1,"c":2}');
    expect(stableStringify([3, 'x', null])).toBe('[3,"x",null]');
    expect(stableStringify(Number.NaN)).toBe('"<non-finite>"');
  });

  it('auditSnapshot removes what the store refuses, and truncates what is too large', () => {
    // The store rejects `undefined` at any depth, deliberately. ActionResult is full of optional
    // fields, so every audit write carrying one threw inside the old swallowing catch.
    expect(auditSnapshot({ a: 1, b: undefined })).toEqual({ a: 1 });
    expect(auditSnapshot(undefined)).toBeNull();
    const big = auditSnapshot({ body: 'x'.repeat(9_000) }) as any;
    expect(big.truncated).toBe(true);
    expect(big.chars).toBeGreaterThan(9_000);
  });
});

describe('6. the trail can be read back, which it never could', () => {
  it('the events come back in sequence, for the action that was dispatched', async () => {
    await new ActionGateway().dispatchAction(bookingRequest());
    const actionId = addedEvents[0].data.actionId;

    const trail = await readActionTrail('org_1', actionId);
    expect(trail.ok).toBe(true);
    if (trail.ok) {
      expect(trail.events.length).toBe(addedEvents.length);
      expect(trail.events.map((e) => e.seq)).toEqual([...trail.events.map((e) => e.seq)].sort((a, b) => a - b));
      expect(trail.events[0].status).toBe('PROPOSED');
    }
  });

  it('ordering is numeric, not lexicographic', async () => {
    // `orderBy('seq')` in the datastore compares `data->>'seq'` as TEXT, where "10" sorts before
    // "2" — a defect that only appears on an action's tenth event.
    addedEvents = [10, 2].map((seq) => ({
      path: 'organizations/org_1/actionLogs',
      data: { actionId: 'action_x', seq, status: seq === 2 ? 'DISPATCHING' : 'RECONCILED_APPLIED' },
    }));

    const trail = await readActionTrail('org_1', 'action_x');
    expect(trail.ok && trail.events.map((e) => e.seq)).toEqual([2, 10]);
  });

  it("only that action's events come back", async () => {
    addedEvents = [
      { path: 'p', data: { actionId: 'action_a', seq: 0, status: 'PROPOSED' } },
      { path: 'p', data: { actionId: 'action_b', seq: 0, status: 'PROPOSED' } },
    ];
    const trail = await readActionTrail('org_1', 'action_a');
    expect(trail.ok && trail.events.length).toBe(1);
  });

  it('an unreadable trail is not an empty one', async () => {
    // Answering `[]` for both is how an operator concludes that nothing happened.
    storeAvailable = false;
    const trail = await readActionTrail('org_1', 'action_x');
    expect(trail.ok).toBe(false);
    expect(trail.ok === false && trail.code).toBe('STORE_UNAVAILABLE');
  });

  it('an id that is not one we mint is refused rather than queried', async () => {
    for (const bad of ['', '../../etc', 'a'.repeat(129), null, 42]) {
      const trail = await readActionTrail('org_1', bad as any);
      expect(trail.ok, JSON.stringify(bad)).toBe(false);
      expect(trail.ok === false && trail.code).toBe('VALIDATION_ERROR');
    }
  });
});
