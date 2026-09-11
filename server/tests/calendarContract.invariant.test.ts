import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CreateEventInput } from '../providers/types';

/**
 * A compile-time assertion, held by `tsc` rather than by the runner.
 *
 * `idempotencyKey` being REQUIRED is the protection: Google treats the conference request id as
 * an idempotency key, so a booking retried with a fresh one mints a second Meet conference for
 * one meeting and the customer gets two links. A runtime guard alone does not hold that — a
 * caller can simply omit the field and discover the problem in production.
 *
 * Making the field optional was mutation-tested and SURVIVED the whole suite, because vitest's
 * transform strips types without checking them. `@ts-expect-error` fails compilation when the
 * error it expects does not occur, so this line turns "the field is required" into something
 * the gate can fail on.
 */
// @ts-expect-error — omitting idempotencyKey must not compile
const _idempotencyKeyIsRequired: CreateEventInput = {
  title: 'x',
  startAtUtc: '2026-09-08T10:00:00.000Z',
  endAtUtc: '2026-09-08T10:30:00.000Z',
  timeZone: 'Europe/London',
  attendees: [],
};
void _idempotencyKeyIsRequired;

/**
 * S41 / S31 — the calendar adapter, and the conflict check that was thrown away.
 *
 * `CalendarProvider` was declared in P1.11 and a repo-wide search for `implements
 * CalendarProvider` returned zero hits, so the contract could not be checked by the compiler or
 * substituted in a test. Meanwhile the only free/busy call in the repository lived inside an
 * unreachable method and ended:
 *
 *     const fbData = await fbRes.json();                      // no res.ok check
 *     const hasConflict = fbData.calendars?.primary?.busy?.length > 0;
 *     ...                                                     // never read again
 *
 * §31 asks exactly one question — when free/busy reports busy, how many create requests are
 * issued? These tests answer it by counting, at the gateway, with the adapter substituted.
 */

// ---------------------------------------------------------------------------
// Datastore and flag doubles, following the pattern established in
// capabilityPreflight.invariant.test.ts.
// ---------------------------------------------------------------------------
let oauthDocs: Record<string, unknown>[] = [];
let storeAvailable = true;


let realActionsEnabled = true;
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

vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
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

/**
 * The adapter double COUNTS. §31 is a claim about a number of requests, so the test has to be
 * able to state that number — an assertion that the gateway "returned an error" would pass
 * just as well if it had created the event first and then complained.
 */
let availabilityAnswer: { availability: string; reason: string } = {
  availability: 'FREE',
  reason: 'stub',
};
let availabilityThrows: unknown = null;
let availabilityCalls: any[] = [];
let createEventCalls: any[] = [];
let createEventResult: { eventId: string; conferenceUrl: string | null } = {
  eventId: 'goog-evt-1',
  conferenceUrl: 'https://meet.google.com/abc-defg-hij',
};

vi.mock('../services/calendar.service', () => ({
  calendarService: {
    setCredentials: () => undefined,
    checkAvailability: async (input: any) => {
      availabilityCalls.push(input);
      if (availabilityThrows !== null) throw availabilityThrows;
      return availabilityAnswer;
    },
    createEvent: async (input: any) => {
      createEventCalls.push(input);
      return createEventResult;
    },
  },
  GoogleCalendarService: class {},
  CalendarService: class {},
}));

const { ActionGateway, ActionType } = await import('../gateway/actionGateway');

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

function bookingRequest(over: Record<string, unknown> = {}) {
  return {
    actionType: ActionType.CALENDAR_CREATE,
    organizationId: 'org_1',
    targetId: 'contact_1',
    proposedBy: 'test',
    payload: {
      title: 'Intro call',
      startTime: '2026-09-08T10:00:00.000Z',
      endTime: '2026-09-08T10:30:00.000Z',
      timezone: 'Europe/London',
      attendees: ['buyer@acme.example'],
      idempotencyKey: 'org_1:contact_1:1757325600000:30',
      ...over,
    },
  } as any;
}

describe('S31 — free/busy reports busy, and the create request count is zero', () => {
  let gateway: any;

  beforeEach(() => {
    oauthDocs = [
      { provider: 'gmail', scopes: [CALENDAR_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'real-token' },
    ];
    storeAvailable = true;
    realActionsEnabled = true;
    availabilityAnswer = { availability: 'FREE', reason: 'stub' };
    availabilityThrows = null;
    availabilityCalls = [];
    createEventCalls = [];
    createEventResult = { eventId: 'goog-evt-1', conferenceUrl: 'https://meet.google.com/abc-defg-hij' };
    gateway = new ActionGateway();
  });

  it('THE INVARIANT — BUSY produces ZERO create requests', async () => {
    availabilityAnswer = { availability: 'BUSY', reason: 'Busy on 1 of 2 calendar(s): primary.' };
    const result = await gateway.dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CALENDAR_CONFLICT');
  });

  it('UNKNOWN produces ZERO create requests — unknown is not permission (§14)', async () => {
    availabilityAnswer = {
      availability: 'UNKNOWN',
      reason: 'Availability could not be established for 1 of 2 calendar(s).',
    };
    const result = await gateway.dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(0);
    expect(result.errorCode).toBe('AVAILABILITY_UNKNOWN');
  });

  it('an availability value nobody anticipated also produces zero create requests', async () => {
    // The gate is written as a check for the one permitting value, not as `=== UNKNOWN`, so a
    // fourth member added to the union cannot slip through as permission.
    availabilityAnswer = { availability: 'PROBABLY_FINE' as any, reason: 'invented' };
    const result = await gateway.dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(0);
    expect(result.errorCode).toBe('AVAILABILITY_UNKNOWN');
  });

  it('FREE produces exactly one create request', async () => {
    const result = await gateway.dispatchAction(bookingRequest());
    expect(createEventCalls.length).toBe(1);
    expect(result.success).toBe(true);
    expect(result.providerResult.eventId).toBe('goog-evt-1');
  });

  it('a failed availability LOOKUP is not an ambiguous WRITE', async () => {
    // Nothing was created, so this must not reach the §32 reconciliation path and be recorded
    // as "this may have happened" — which is what a bare rethrow would have produced, since
    // CALENDAR_CREATE is irreversible and an unclassifiable error is AMBIGUOUS.
    availabilityThrows = Object.assign(new Error('boom'), { code: 'ECONNRESET' });
    const result = await gateway.dispatchAction(bookingRequest());

    expect(createEventCalls.length).toBe(0);
    expect(result.errorCode).toBe('AVAILABILITY_UNKNOWN');
    expect(result.errorKind).toBe('CONNECTION_FAILED');
    expect(result.requiresReconciliation).toBeFalsy();
  });

  it('no usable credential refuses before any provider call', async () => {
    oauthDocs = [{ provider: 'gmail', scopes: [CALENDAR_SCOPE], status: 'ACTIVE', expiresAt: null, accessToken: 'mock_token' }];
    const result = await gateway.dispatchAction(bookingRequest());
    expect(createEventCalls.length).toBe(0);
    expect(result.errorCode).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('A FABRICATED EVENT ID IS NOT A BOOKED MEETING', async () => {
    // The email path has had this guard since P0.8 (outbox.worker.ts). The calendar path had
    // none, which is how `providerResult: { eventId: 'mock_evt_123' }` could have become a
    // meeting a customer was told about.
    createEventResult = { eventId: 'mock_evt_123', conferenceUrl: null };
    const result = await gateway.dispatchAction(bookingRequest());
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('FABRICATED_PROVIDER_ID');
  });

  it('the conference request id is derived from the booking, not from the clock', async () => {
    await gateway.dispatchAction(bookingRequest());
    expect(createEventCalls[0].idempotencyKey).toBe('org_1:contact_1:1757325600000:30');
  });

  it('the attendees reach the availability check AND the event', async () => {
    // Asserting only the create call survived a mutation that emptied the attendee list on the
    // availability call: the event was still created with the right attendees, having been
    // checked against a calendar set that did not include them. "Is this slot free" answered
    // about the wrong calendars is worse than not answered.
    await gateway.dispatchAction(bookingRequest());
    expect(availabilityCalls.length).toBe(1);
    expect(availabilityCalls[0].attendees).toEqual(['buyer@acme.example']);
    expect(createEventCalls[0].attendees).toEqual(['buyer@acme.example']);
  });

  it('the window asked about is the window booked', async () => {
    await gateway.dispatchAction(bookingRequest());
    expect(availabilityCalls[0].startAtUtc).toBe(createEventCalls[0].startAtUtc);
    expect(availabilityCalls[0].endAtUtc).toBe(createEventCalls[0].endAtUtc);
    expect(availabilityCalls[0].timeZone).toBe('Europe/London');
  });

  it('an out-of-hours slot is refused before availability is even asked about', async () => {
    const result = await gateway.dispatchAction(
      bookingRequest({ startTime: '2026-09-08T03:00:00.000Z', endTime: '2026-09-08T03:30:00.000Z' })
    );
    expect(result.errorCode).toBe('OUTSIDE_BUSINESS_HOURS');
    expect(createEventCalls.length).toBe(0);
  });
});

// ===========================================================================
describe('the adapter itself, driven against a stubbed transport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const realAdapter = async () => {
    const actual = await vi.importActual<typeof import('../services/calendar.service')>(
      '../services/calendar.service'
    );
    const svc = new actual.GoogleCalendarService();
    svc.setCredentials({ access_token: 'tok' });
    return { svc, actual };
  };

  const window = {
    startAtUtc: '2026-09-08T10:00:00.000Z',
    endAtUtc: '2026-09-08T10:30:00.000Z',
    timeZone: 'Europe/London',
    attendees: ['buyer@acme.example'] as readonly string[],
  };

  it('every calendar clear -> FREE', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: { primary: { busy: [] }, 'buyer@acme.example': { busy: [] } },
      }),
    }));
    const { svc } = await realAdapter();
    expect((await svc.checkAvailability(window)).availability).toBe('FREE');
  });

  it('a busy interval on any calendar -> BUSY', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          primary: { busy: [] },
          'buyer@acme.example': { busy: [{ start: 'x', end: 'y' }] },
        },
      }),
    }));
    const { svc } = await realAdapter();
    const r = await svc.checkAvailability(window);
    expect(r.availability).toBe('BUSY');
    expect(r.reason).toContain('buyer@acme.example');
  });

  it('A CALENDAR WE CANNOT READ IS NOT A CALENDAR THAT IS FREE', async () => {
    // Google returns per-calendar `errors` INSIDE a 200 for calendars the credential cannot
    // see, which is the ordinary case for an attendee. The old code read
    // `calendars.primary.busy.length > 0` and would have called this free.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        calendars: {
          primary: { busy: [] },
          'buyer@acme.example': { errors: [{ domain: 'global', reason: 'notFound' }] },
        },
      }),
    }));
    const { svc } = await realAdapter();
    expect((await svc.checkAvailability(window)).availability).toBe('UNKNOWN');
  });

  it('a calendar simply absent from the answer is UNKNOWN, not free', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ calendars: { primary: { busy: [] } } }),
    }));
    const { svc } = await realAdapter();
    expect((await svc.checkAvailability(window)).availability).toBe('UNKNOWN');
  });

  it('THE MISSING res.ok CHECK — a 401 throws instead of reading as free', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      headers: { get: () => null },
    }));
    const { svc } = await realAdapter();
    await expect(svc.checkAvailability(window)).rejects.toMatchObject({ kind: 'UNAUTHENTICATED' });
  });

  it('the attendees are actually asked about', async () => {
    let body: any = null;
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ calendars: {} }) };
    });
    const { svc } = await realAdapter();
    await svc.checkAvailability(window);
    expect(body.items.map((i: any) => i.id)).toEqual(['primary', 'buyer@acme.example']);
  });

  it('a transport failure is classified, not rethrown bare', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    });
    const { svc } = await realAdapter();
    await expect(svc.checkAvailability(window)).rejects.toMatchObject({ kind: 'TIMEOUT' });
  });

  it('THE CONFERENCE REQUEST ID IS DETERMINISTIC — a retry does not mint a second Meet', async () => {
    const { actual } = await realAdapter();
    const a = actual.GoogleCalendarService.conferenceRequestId('booking-7');
    const b = actual.GoogleCalendarService.conferenceRequestId('booking-7');
    expect(a).toBe(b);
    expect(a).not.toBe(actual.GoogleCalendarService.conferenceRequestId('booking-8'));
    expect(a).not.toContain('booking-7');
  });

  it('an event with no idempotency key is refused rather than clock-stamped', async () => {
    const { actual } = await realAdapter();
    expect(() => actual.GoogleCalendarService.conferenceRequestId('')).toThrow();
  });

  it('NO CONFERENCE MEANS null, NOT THE GOOGLE MEET HOMEPAGE', async () => {
    // The old default was `conferenceUrl = "https://meet.google.com/"`, which resolves to a
    // page that is not the meeting and is indistinguishable from a working link until
    // somebody clicks it during the call.
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'evt-1' }),
    }));
    const { svc } = await realAdapter();
    const created = await svc.createEvent({ ...window, title: 'x', idempotencyKey: 'k' });
    expect(created.conferenceUrl).toBeNull();
    expect(created.eventId).toBe('evt-1');
  });

  it('a real video entry point is returned', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'evt-1',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/x-y-z' }] },
      }),
    }));
    const { svc } = await realAdapter();
    expect((await svc.createEvent({ ...window, title: 'x', idempotencyKey: 'k' })).conferenceUrl).toBe(
      'https://meet.google.com/x-y-z'
    );
  });

  it('a create failure carries its status structurally, not in prose', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => 'nope',
      headers: { get: () => null },
    }));
    const { svc } = await realAdapter();
    await expect(svc.createEvent({ ...window, title: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
      status: 403,
    });
  });

  it('a 2xx with no event id is not a created event', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const { svc } = await realAdapter();
    await expect(svc.createEvent({ ...window, title: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({
      kind: 'UNKNOWN',
    });
  });
});

// ===========================================================================
describe('what the source may no longer contain', () => {
  const gateway = strip('server/gateway/actionGateway.ts');
  const calendar = strip('server/services/calendar.service.ts');
  const server = strip('server.ts');

  it('the adapter declares the contract, so the compiler checks it', () => {
    expect(calendar).toContain('export class GoogleCalendarService implements CalendarProvider');
  });

  it('THE DISCARDED CONFLICT CHECK IS GONE', () => {
    expect(gateway).not.toContain('hasConflict');
  });

  it('the fabricated calendar success is gone', () => {
    expect(gateway).not.toContain('mock_evt_123');
    expect(gateway).not.toContain('Mocking CALENDAR_CREATE');
  });

  it('the second, differently-read copy of the calendar flag is gone', () => {
    // P0.2: two readers of one flag, one lazy and one direct, is how the enforcement point and
    // the operator display came to disagree in the first place.
    expect(gateway).not.toContain("process.env.REAL_CALENDAR_CREATE_ENABLED");
  });

  it('the conference request id is no longer minted from the clock', () => {
    expect(gateway).not.toContain('requestId: "req_" + Date.now()');
    expect(calendar).not.toContain('requestId: `meet_${Date.now()}`');
  });

  it('the Meet homepage is no longer a fallback link', () => {
    expect(calendar).not.toContain('let conferenceUrl = "https://meet.google.com/"');
  });

  it('the calendar path no longer looks up a credential by the wrong provider name', () => {
    expect(gateway).toContain('private async findGoogleAccessToken(');
    expect(gateway).toContain("provider === 'google-calendar'");
  });

  it('DISPATCH HAS A SECOND CALL SITE, AND IT IS THE LIVE BOOKING PATH', () => {
    // Every §31 finding in this document has rested on the same fact: dispatchAction had one
    // call site and it hardcoded EMAIL_SEND, so the calendar branch was unreachable.
    //
    // The needle is the AWAITED ASSIGNMENT, not the call text. A mutation that changed the
    // call to `const _unused = () => actionGateway.dispatchAction({...})` — dispatching
    // nothing, since the arrow is never invoked — passed an assertion that only looked for
    // `actionGateway.dispatchAction({`.
    expect(server).toContain('const dispatchResult = await actionGateway.dispatchAction({');
    expect(server).toContain('actionType: ActionType.CALENDAR_CREATE');
  });

  it('a provider conflict refuses the booking rather than recording it', () => {
    expect(server).toContain("dispatchResult.errorCode === 'CALENDAR_CONFLICT'");
    expect(server).toContain("dispatchResult.errorCode === 'AVAILABILITY_UNKNOWN'");
  });

  it('the meeting record reports what the dispatch actually returned', () => {
    expect(server).toContain('providerSyncStatus,');
    expect(server).toContain('providerEventId,');
    expect(server).not.toContain("providerSyncStatus: 'PENDING_CALENDAR_SYNC',");
  });
});

function strip(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
