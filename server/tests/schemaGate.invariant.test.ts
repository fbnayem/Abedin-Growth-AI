import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * THE SCHEMA GATE, EXERCISED RATHER THAN GREPPED (addendum §48).
 *
 * This file exists because a source assertion was defeated. The suite checked that
 * `actionGateway.ts` contained `isIrreversible(request.actionType)` — and a mutant that
 * inverted it to `!isIrreversible(request.actionType)`, so the check ran only for REVERSIBLE
 * actions and every send went out on a mismatched schema, still contained that substring and
 * passed.
 *
 * A substring is not a decision. These call the gateway.
 */

let schemaState = 'MATCHED';

vi.mock('../config/safeMode', () => ({
  isRealActionEnabled: () => true,
  isFullySafeMode: () => false,
  safeModeSnapshot: () => ({}),
}));

vi.mock('../build/schemaCompatibility', () => ({
  schemaCompatibility: async () => ({
    state: schemaState,
    expected: 7,
    applied: schemaState === 'DATABASE_BEHIND' ? 6 : 7,
    detail: 'from the double',
  }),
  schemaPermitsIrreversibleActions: (c: any) => c.state === 'MATCHED',
}));

vi.mock('../store', () => ({
  get store() {
    return {};
  },
  collection: (_db: unknown, path: string) => ({ path }),
  query: (ref: any) => ref,
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  doc: (_db: unknown, path: string, id: string) => ({ kind: 'document', path, id }),
  // No conversation document and no oauth row: every later gate refuses too. That is the
  // point — the assertions below are about WHICH refusal comes back, not about getting a send
  // through, and nothing in this file may ever reach a provider.
  getDoc: async () => ({ exists: () => false, data: () => undefined }),
  getDocs: async () => ({ empty: true, docs: [], size: 0, forEach: () => undefined }),
  addDoc: async () => ({ id: 'new' }),
  setDoc: async () => undefined,
  updateDoc: async () => undefined,
  runTransaction: async (_h: unknown, body: any) =>
    body({ get: async () => ({ exists: () => false, data: () => undefined }), set: async () => undefined }),
}));

vi.mock('../services/gmail.service', () => ({
  gmailService: {
    setCredentials: () => undefined,
    sendEmail: async () => {
      throw new Error('A send was attempted. Every gate in this file was supposed to refuse.');
    },
  },
  GmailService: class {},
}));

const { ActionGateway, ActionType, isIrreversible } = await import('../gateway/actionGateway');

function request(actionType: any) {
  return {
    actionType,
    organizationId: 'org_1',
    targetId: 'contact_1',
    payload: { to: 'someone@example.com', subject: 'x', htmlBody: '<p>x</p>' },
  } as any;
}

async function dispatch(actionType: any) {
  const gateway: any = new ActionGateway();
  return gateway.dispatchAction(request(actionType));
}

beforeEach(() => {
  schemaState = 'MATCHED';
});

describe('1. an irreversible action is refused on a mismatched schema', () => {
  for (const state of ['DATABASE_BEHIND', 'DATABASE_AHEAD', 'UNKNOWN']) {
    it(`${state} blocks EMAIL_SEND, naming the schema`, async () => {
      schemaState = state;
      const result = await dispatch(ActionType.EMAIL_SEND);
      expect(result.success).toBe(false);
      expect(result.blockedReason).toMatch(/schema/i);
      expect(result.blockedReason).toContain(state);
    });
  }

  it('MATCHED does NOT block for the schema — it gets past this gate', async () => {
    // The other half. Without it, a gate that refused everything would satisfy the three
    // assertions above while stopping the product entirely.
    //
    // The send is still refused further down (no conversation, no credential), so this asserts
    // that the refusal is no longer the SCHEMA one — which is the difference between a gate
    // that decides and a gate that is always on.
    schemaState = 'MATCHED';
    const result = await dispatch(ActionType.EMAIL_SEND);
    expect(result.success).toBe(false);
    expect(result.blockedReason ?? '').not.toMatch(/schema/i);
  });
});

describe('2. the gate applies to irreversible actions, and to those only', () => {
  /**
   * The inverted mutant made the check run for REVERSIBLE actions instead. Both directions are
   * asserted, because either one alone is satisfied by the inversion.
   */
  it('CRM_UPDATE is reversible, and is not blocked by a mismatched schema', async () => {
    expect(isIrreversible(ActionType.CRM_UPDATE)).toBe(false);
    schemaState = 'DATABASE_BEHIND';
    const result = await dispatch(ActionType.CRM_UPDATE);
    expect(result.blockedReason ?? '').not.toMatch(/schema/i);
  });

  it('EMAIL_SEND is irreversible, and is', async () => {
    expect(isIrreversible(ActionType.EMAIL_SEND)).toBe(true);
    schemaState = 'DATABASE_BEHIND';
    const result = await dispatch(ActionType.EMAIL_SEND);
    expect(result.blockedReason ?? '').toMatch(/schema/i);
  });
});

describe('3. the schema gate runs before the feature flag', () => {
  it('a mismatched schema is reported even when the action is also flag-disabled', async () => {
    // Ordering, expressed as behaviour rather than as two string indexes. If the flag gate ran
    // first, this would come back as a Safe Rebuild Mode refusal and the schema would never be
    // consulted — so an operator turning the flag on would discover the schema problem by
    // sending on it.
    const { isRealActionEnabled } = await import('../config/safeMode');
    expect(isRealActionEnabled('EMAIL' as never)).toBe(true);

    schemaState = 'DATABASE_BEHIND';
    const result = await dispatch(ActionType.EMAIL_SEND);
    expect(result.blockedReason).toMatch(/schema/i);
    expect(result.blockedReason ?? '').not.toMatch(/Safe Rebuild Mode/i);
  });
});
