import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE TWO PLACES THE LOCK IS ENFORCED, AND THE ONE PLACE IT IS SET.
 *
 * `autonomyLock.invariant.test.ts` proves the decision function. This proves the code that
 * calls it — which is where the original defect lived, and where two mutants survived:
 *
 *   - The gateway read a missing datastore as "nobody has paused this conversation" and let
 *     the send through. `checkHumanOwnershipLock` runs at `dispatchAction` line 226, before
 *     anything else refuses on a null store, so that branch is genuinely reachable.
 *   - The route's attribution check could be deleted without a single test noticing.
 *
 * Both are reached the way `capabilityPreflight.invariant.test.ts` reaches its subject: by
 * calling the unit whose behaviour is at stake, rather than by asserting on source text. A
 * source assertion cannot tell a guard from a guard that is never reached.
 */

let storeAvailable = true;
let documentExists = false;
let documentData: Record<string, unknown> | undefined;
let readShouldThrow = false;

vi.mock('../config/safeMode', () => ({
  isRealActionEnabled: () => false,
  isFullySafeMode: () => true,
  safeModeSnapshot: () => ({}),
}));

vi.mock('../store', () => ({
  get store() {
    return storeAvailable ? {} : null;
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any) => ref,
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (_db: unknown, path: string, id: string) => ({ kind: 'document', path, id }),
  getDoc: async () => {
    if (readShouldThrow) throw new Error('datastore unavailable');
    return { exists: () => documentExists, data: () => documentData };
  },
  getDocs: async () => ({ empty: true, docs: [], size: 0, forEach: () => undefined }),
  addDoc: async () => ({ id: 'new' }),
  setDoc: async () => undefined,
  updateDoc: async () => undefined,
  runTransaction: async (_h: unknown, body: any) =>
    body({
      get: async () => ({ exists: () => documentExists, data: () => documentData }),
      set: async () => undefined,
    }),
}));

const { ActionGateway } = await import('../gateway/actionGateway');
const { autonomyRouter } = await import('../routes/autonomy.routes');

beforeEach(() => {
  storeAvailable = true;
  documentExists = false;
  documentData = undefined;
  readShouldThrow = false;
});

/** True means LOCKED — the send must not proceed. */
function locked(): Promise<boolean> {
  const gateway: any = new ActionGateway();
  return gateway.checkHumanOwnershipLock('org_1', 'conv_1');
}

describe('1. the gateway refuses whenever it cannot establish that nobody has paused', () => {
  it('refuses when there is no datastore at all', async () => {
    // The original inversion: `if (!store) return false` meant a missing datastore was read as
    // "no human has taken this conversation", and the send went out. This runs before any
    // other null-store refusal in dispatchAction, so it decided on its own.
    storeAvailable = false;
    expect(await locked()).toBe(true);
  });

  it('refuses when the conversation document does not exist', async () => {
    documentExists = false;
    expect(await locked()).toBe(true);
  });

  it('refuses when the read throws', async () => {
    readShouldThrow = true;
    expect(await locked()).toBe(true);
  });

  it('refuses when the stored flag is a value nobody here wrote', async () => {
    documentExists = true;
    documentData = { autonomyPausedByHuman: 'false' };
    expect(await locked()).toBe(true);
  });

  it('refuses when a human has paused the conversation', async () => {
    documentExists = true;
    documentData = { autonomyPausedByHuman: true };
    expect(await locked()).toBe(true);
  });

  it('refuses on the legacy status the worker already honoured', async () => {
    // The gateway did NOT honour this before, so a conversation paused by status was stopped
    // by the worker and permitted here — two guards, same conversation, opposite answers.
    documentExists = true;
    documentData = { status: 'AUTONOMY_PAUSED_BY_HUMAN' };
    expect(await locked()).toBe(true);
  });

  it('PERMITS an untouched conversation', async () => {
    // The other half. Without it, a gateway that refused everything would satisfy every
    // assertion above while stopping the product.
    documentExists = true;
    documentData = { inboundVersion: 3 };
    expect(await locked()).toBe(false);
  });

  it('PERMITS a conversation that was explicitly resumed', async () => {
    documentExists = true;
    documentData = { autonomyPausedByHuman: false, status: 'AUTONOMY_PAUSED_BY_HUMAN' };
    expect(await locked()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The route. Express routers are middleware functions, so one can be called.
// ---------------------------------------------------------------------------
interface Answer {
  status: number;
  body: any;
}

function callRoute(req: any): Promise<Answer> {
  return new Promise((resolve) => {
    const res: any = {
      statusCode: 200,
      headersSent: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader() {
        return this;
      },
      json(body: any) {
        resolve({ status: this.statusCode, body });
        return this;
      },
    };
    (autonomyRouter as any)(req, res, () => resolve({ status: 404, body: null }));
  });
}

function post(body: unknown, user: unknown): any {
  return {
    method: 'POST',
    url: '/conv_1',
    originalUrl: '/api/autonomy/conv_1',
    baseUrl: '/api/autonomy',
    headers: {},
    body,
    user,
    tenant: { orgId: 'acme', source: 'TOKEN_CLAIM', uid: 'u1' },
    requestId: 'req-1',
  };
}

describe('2. the route attributes the change to the caller who made it', () => {
  it('records the authenticated operator, not a constant', async () => {
    // The surviving mutant replaced the attribution gate with a hardcoded actor. Asserting
    // that the recorded actor is the REQUEST's user is what tells those two apart.
    const answer = await callRoute(
      post({ paused: true, reason: 'customer phoned in' }, { email: 'ops@example.com' })
    );
    expect(answer.status).toBe(200);
    expect(answer.body.actor).toBe('ops@example.com');
    expect(answer.body.to).toBe('PAUSED');
  });

  it('a different operator is recorded differently', async () => {
    const answer = await callRoute(
      post({ paused: false, reason: 'resolved' }, { email: 'other@example.com' })
    );
    expect(answer.body.actor).toBe('other@example.com');
    expect(answer.body.to).toBe('RUNNING');
  });

  it('falls back to the uid when there is no email', async () => {
    const answer = await callRoute(post({ paused: true, reason: 'r' }, { uid: 'uid-77' }));
    expect(answer.body.actor).toBe('uid-77');
  });

  it('an unattributable caller is recorded as unattributed, naming nobody', async () => {
    // NODE_ENV is not production here, so an unattributed operator may still act — the
    // asymmetry S38 established. What must never happen is a name being invented for them.
    const answer = await callRoute(post({ paused: true, reason: 'r' }, undefined));
    expect(answer.body.actor).toBeNull();
    expect(answer.body.unattributedBecause).toBeTruthy();
  });

  it('a malformed body is refused before anything is written', async () => {
    const answer = await callRoute(post({ paused: 'true', reason: 'r' }, { email: 'a@b.c' }));
    expect(answer.status).toBe(400);
    expect(answer.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('a change with no reason is refused', async () => {
    const answer = await callRoute(post({ paused: true }, { email: 'a@b.c' }));
    expect(answer.status).toBe(400);
  });

  it('reports the state it came from, read inside the transaction', async () => {
    documentExists = true;
    documentData = { autonomyPausedByHuman: true };
    const answer = await callRoute(
      post({ paused: false, reason: 'resolved' }, { email: 'a@b.c' })
    );
    expect(answer.body.from).toBe('PAUSED');
    expect(answer.body.to).toBe('RUNNING');
  });
});
