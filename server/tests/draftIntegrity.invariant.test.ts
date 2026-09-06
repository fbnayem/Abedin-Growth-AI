import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * INVARIANTS (addendum §8, §9 / P0.12).
 *
 * §8 A draft generated before a newer inbound message must not be sent.
 * §9 An approval binds to the exact content approved; altering it voids the approval.
 *
 * Both were unenforced. The stale check compared wall-clock timestamps against a Postgres
 * table the Firestore write path never populated, so it evaluated zero rows and always
 * passed. There was no approval digest at all, so "approve draft -> AI regenerates body ->
 * old approval still counts" was a valid sequence.
 *
 * Firestore is mocked so these tests exercise the decision logic without a live datastore.
 */

let mockVersions: Record<string, number> = {};
let versionShouldThrow = false;

vi.mock('../firebase', () => ({
  firestore: {},
  firebaseAuth: null,
}));

// Keyed on the FULL path, not the document id. Keying on the id alone could not express
// two tenants each holding a conversation called 'conv_1', which is exactly the collision
// P1.1 has to survive.
vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, path: string, id: string) => ({ path: `${path}/${id}`, id }),
  getDoc: async (ref: any) => {
    if (versionShouldThrow) throw new Error('datastore unavailable');
    const key = ref.path as string;
    const exists = Object.prototype.hasOwnProperty.call(mockVersions, key);
    return {
      exists: () => exists,
      data: () => (exists ? { inboundVersion: mockVersions[key] } : undefined),
    };
  },
  runTransaction: async (_db: unknown, fn: any) => {
    return fn({
      get: async (ref: any) => {
        const key = ref.path as string;
        const exists = Object.prototype.hasOwnProperty.call(mockVersions, key);
        return {
          exists: () => exists,
          data: () => (exists ? { inboundVersion: mockVersions[key] } : undefined),
        };
      },
      set: (ref: any, value: any) => {
        mockVersions[ref.path] = value.inboundVersion;
      },
    });
  },
}));

const {
  computeApprovalDigest,
  verifyDraftIntegrity,
  incrementInboundVersion,
  getInboundVersion,
} = await import('../services/draftIntegrity.service');

const ORG = 'acme';
const OTHER_ORG = 'globex';

/** The datastore key the service will build for a conversation. */
const key = (org: string, conv: string) => `organizations/${org}/conversations/${conv}`;

const baseJob = (over: Partial<any> = {}) => ({
  id: 'job_1',
  organizationId: ORG,
  conversationId: 'conv_1',
  payload: { to: 'prospect@example.com', subject: 'Re: pricing', htmlBody: '<p>Hello</p>' },
  ...over,
});

beforeEach(() => {
  mockVersions = {};
  versionShouldThrow = false;
});

describe('§8 — inbound version increments atomically', () => {
  it('starts at 1 for a conversation with no prior version', async () => {
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(1);
  });

  it('increments monotonically', async () => {
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(1);
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(2);
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(3);
  });

  it('tracks conversations independently', async () => {
    await incrementInboundVersion(ORG, 'conv_1');
    await incrementInboundVersion(ORG, 'conv_1');
    await incrementInboundVersion(ORG, 'conv_2');

    expect(await getInboundVersion(ORG, 'conv_1')).toBe(2);
    expect(await getInboundVersion(ORG, 'conv_2')).toBe(1);
  });

  it('reports 0 for a conversation that has received nothing', async () => {
    expect(await getInboundVersion(ORG, 'never_seen')).toBe(0);
  });
});

describe('§8 — a stale draft is refused', () => {
  it('ACCEPTS a draft whose version matches the conversation', async () => {
    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(baseJob({ generatedForInboundVersion: 5 }));
    expect(verdict.ok).toBe(true);
  });

  it('REFUSES a draft generated before a newer inbound message', async () => {
    // The core §8 scenario: draft written at v5, customer replies (v6), draft must not send.
    mockVersions[key(ORG, 'conv_1')] = 6;
    const verdict = await verifyDraftIntegrity(baseJob({ generatedForInboundVersion: 5 }));

    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.code).toBe('STALE_DRAFT');
      expect(verdict.reason).toMatch(/version 6.*version 5/s);
    }
  });

  it('REFUSES a draft stamped with a version AHEAD of the conversation', async () => {
    // Equality, not "not older". A draft ahead of the conversation means something is wrong
    // with provenance, and guessing is not safe.
    mockVersions[key(ORG, 'conv_1')] = 3;
    const verdict = await verifyDraftIntegrity(baseJob({ generatedForInboundVersion: 4 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('STALE_DRAFT');
  });

  it('REFUSES an unstamped draft rather than assuming it is current', async () => {
    // Drafts predating this mechanism have unknown provenance; unknown is not permission.
    mockVersions[key(ORG, 'conv_1')] = 1;
    const verdict = await verifyDraftIntegrity(baseJob({ generatedForInboundVersion: undefined }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('UNSTAMPED_DRAFT');
  });

  it('FAILS CLOSED when the version cannot be read at all', async () => {
    versionShouldThrow = true;
    await expect(
      verifyDraftIntegrity(baseJob({ generatedForInboundVersion: 1 }))
    ).rejects.toThrow();
    // Throwing is correct: the worker's catch marks the job failed rather than sending it.
  });
});

describe('§9 — approval binds to exact content', () => {
  const digestFor = (over: Partial<any> = {}) =>
    computeApprovalDigest({
      organizationId: ORG,
      to: 'prospect@example.com',
      subject: 'Re: pricing',
      htmlBody: '<p>Hello</p>',
      conversationId: 'conv_1',
      inboundVersion: 5,
      ...over,
    });

  it('accepts content that matches its approval digest', async () => {
    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(
      baseJob({ generatedForInboundVersion: 5, approvalDigest: digestFor() })
    );
    expect(verdict.ok).toBe(true);
  });

  it('REFUSES when the body changed after approval', async () => {
    // "approve draft -> AI regenerates body -> old approval still valid" must be impossible.
    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(
      baseJob({
        generatedForInboundVersion: 5,
        approvalDigest: digestFor(),
        payload: { to: 'prospect@example.com', subject: 'Re: pricing', htmlBody: '<p>DIFFERENT</p>' },
      })
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('DIGEST_MISMATCH');
  });

  it('REFUSES when the recipient changed after approval', async () => {
    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(
      baseJob({
        generatedForInboundVersion: 5,
        approvalDigest: digestFor(),
        payload: { to: 'attacker@evil.com', subject: 'Re: pricing', htmlBody: '<p>Hello</p>' },
      })
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('DIGEST_MISMATCH');
  });

  it('REFUSES when the subject changed after approval', async () => {
    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(
      baseJob({
        generatedForInboundVersion: 5,
        approvalDigest: digestFor(),
        payload: { to: 'prospect@example.com', subject: 'URGENT: wire transfer', htmlBody: '<p>Hello</p>' },
      })
    );
    expect(verdict.ok).toBe(false);
  });
});

describe('§9 — the digest itself is sound', () => {
  it('is deterministic for identical input', () => {
    const a = computeApprovalDigest({
      organizationId: ORG, to: 'a@b.com', subject: 's', htmlBody: 'b', conversationId: 'c', inboundVersion: 1,
    });
    const b = computeApprovalDigest({
      organizationId: ORG, to: 'a@b.com', subject: 's', htmlBody: 'b', conversationId: 'c', inboundVersion: 1,
    });
    expect(a).toBe(b);
  });

  it('changes when the conversation version changes', () => {
    const v1 = computeApprovalDigest({
      organizationId: ORG, to: 'a@b.com', subject: 's', htmlBody: 'b', conversationId: 'c', inboundVersion: 1,
    });
    const v2 = computeApprovalDigest({
      organizationId: ORG, to: 'a@b.com', subject: 's', htmlBody: 'b', conversationId: 'c', inboundVersion: 2,
    });
    expect(v1).not.toBe(v2);
  });

  it('cannot be defeated by shifting content across a field boundary', () => {
    // Without a delimiter that cannot occur in the values, subject "AB" + body "" and
    // subject "A" + body "B" would hash identically.
    const a = computeApprovalDigest({
      organizationId: ORG, to: 'x@y.com', subject: 'AB', htmlBody: '', conversationId: 'c', inboundVersion: 1,
    });
    const b = computeApprovalDigest({
      organizationId: ORG, to: 'x@y.com', subject: 'A', htmlBody: 'B', conversationId: 'c', inboundVersion: 1,
    });
    expect(a).not.toBe(b);
  });

  it('produces a hex sha256', () => {
    const d = computeApprovalDigest({
      organizationId: ORG, to: 'a@b.com', subject: 's', htmlBody: 'b', conversationId: 'c', inboundVersion: 1,
    });
    expect(d).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('§4 / P1.1 — conversation state is per tenant', () => {
  it('does NOT share an inbound version between two organisations using the same conversation id', async () => {
    // Conversation ids are generated per tenant and WILL collide across tenants. Before P1.1
    // every conversation lived under one hardcoded organisation, so two tenants with a
    // 'conv_1' shared a single version counter: one tenant receiving a message would have
    // invalidated the other tenant's approved draft, and a draft could be validated against
    // a conversation belonging to somebody else entirely.
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(1);
    expect(await incrementInboundVersion(ORG, 'conv_1')).toBe(2);
    expect(await incrementInboundVersion(OTHER_ORG, 'conv_1')).toBe(1);

    expect(await getInboundVersion(ORG, 'conv_1')).toBe(2);
    expect(await getInboundVersion(OTHER_ORG, 'conv_1')).toBe(1);
  });

  it('REFUSES a job whose organisation does not match where its version lives', async () => {
    // The job names ORG; only OTHER_ORG has a version recorded for this conversation. The
    // check must read ORG's copy (version 0) and refuse, not find OTHER_ORG's and accept.
    mockVersions[key(OTHER_ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(baseJob({ generatedForInboundVersion: 5 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('STALE_DRAFT');
  });

  it('rejects an organisation id that would change the shape of the datastore path', async () => {
    // orgPath validates before concatenating. Without it, '../oauth_connections' as an org id
    // would retarget the read out of the tenant subtree entirely.
    await expect(
      verifyDraftIntegrity(
        baseJob({ organizationId: '../oauth_connections', generatedForInboundVersion: 1 })
      )
    ).rejects.toThrow(/not a valid identifier/);
  });
});

describe('§9 / P1.1 — the approval digest binds the tenant', () => {
  it('does not validate an approval across organisations', async () => {
    const digestForOther = computeApprovalDigest({
      organizationId: OTHER_ORG,
      to: 'prospect@example.com',
      subject: 'Re: pricing',
      htmlBody: '<p>Hello</p>',
      conversationId: 'conv_1',
      inboundVersion: 5,
    });

    mockVersions[key(ORG, 'conv_1')] = 5;
    const verdict = await verifyDraftIntegrity(
      baseJob({ generatedForInboundVersion: 5, approvalDigest: digestForOther })
    );

    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe('DIGEST_MISMATCH');
  });
});
