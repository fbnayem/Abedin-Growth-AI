import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ID_SCHEME,
  IdentityError,
  PUBLIC_EMAIL_DOMAINS,
  accountDocId,
  accountDomain,
  contactDocId,
  plusAddressTag,
  suggestedBaseAddress,
  tryContactDocId,
} from '../lib/identity';
import {
  SUPPRESSION_SIGNALS,
  hasAffirmativeConsent,
  isSuppressed,
  planContactMerge,
  suppressionLabels,
} from '../domain/contactMerge';
import {
  MAX_REFERENCES,
  parseMessageIds,
  referencedMessageIds,
  resolveThread,
} from '../domain/threadResolution';

/**
 * INVARIANTS (addendum §29, §15, §14, §18 / P1.5).
 *
 * §29 One person is one record. The id is derived, so a duplicate is unrepresentable rather
 *     than merely discouraged.
 * §15 A merge preserves the audit trail and reparents what pointed at the merged record.
 * §14 A merge never converts a refusal into permission.
 * §18 Thread routing is chosen partly from attacker-supplied headers, so a header match must
 *     be confirmed before an inbound message joins someone else's conversation.
 */

describe('§29 — the same person derives the same id, and different people do not', () => {
  it('is stable across the variations that produced duplicates', () => {
    const canonical = contactDocId('alice@example.com');
    for (const variant of [
      'alice@example.com',
      'ALICE@EXAMPLE.COM',
      '  Alice@Example.Com  ',
      'Alice Smith <alice@example.com>',
      '"Smith, Alice" <ALICE@example.com>',
    ]) {
      expect(contactDocId(variant), variant).toBe(canonical);
    }
  });

  it('gives different people different ids', () => {
    const ids = new Set(
      ['a@example.com', 'b@example.com', 'a@example.org', 'a.b@example.com'].map(contactDocId)
    );
    expect(ids.size).toBe(4);
  });

  it('produces an id Firestore will accept', () => {
    // Firestore rejects ids containing a forward slash, the ids '.' and '..', and ids wrapped
    // in double underscores; it caps them at 1500 bytes. A forward slash is legal in an email
    // local part, so the raw address would not be a safe id.
    const awkward = [
      'a/b@example.com',
      '.@example.com',
      '..@example.com',
      '__proto__@example.com',
      `${'x'.repeat(300)}@example.com`,
    ];
    for (const email of awkward) {
      const id = contactDocId(email);
      expect(id.includes('/'), email).toBe(false);
      expect(id === '.' || id === '..').toBe(false);
      expect(/^__.*__$/.test(id), email).toBe(false);
      expect(Buffer.byteLength(id, 'utf8')).toBeLessThan(1500);
    }
  });

  it('carries the scheme tag, so a normalisation change cannot silently orphan documents', () => {
    expect(contactDocId('a@example.com')).toContain(`_${ID_SCHEME}_`);
  });

  it('REFUSES to invent an id for an address it cannot use', () => {
    // The tempting failure is to return '' or 'unknown'. Either gives every unidentifiable
    // contact the same id, which does not fail to deduplicate — it merges strangers.
    for (const bad of [null, undefined, '', '   ', 'not-an-email', '@example.com', 'a@', 42, {}]) {
      expect(() => contactDocId(bad), JSON.stringify(bad)).toThrow(IdentityError);
      expect(tryContactDocId(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('§29 — accounts are derived from company domains, never from free mail', () => {
  it('derives a domain for a company address', () => {
    expect(accountDomain('alice@acme-corp.com')).toBe('acme-corp.com');
    expect(accountDocId('alice@acme-corp.com')).toBe(accountDocId('bob@ACME-CORP.com'));
  });

  it('REFUSES to group free-mail addresses into a shared account', () => {
    // Every gmail.com contact joining one "account" would put strangers into a shared company
    // history, which the reply composer then reads as context for a draft.
    for (const domain of ['gmail.com', 'outlook.com', 'icloud.com', 'proton.me', 'qq.com']) {
      expect(accountDomain(`someone@${domain}`), domain).toBeNull();
      expect(accountDocId(`someone@${domain}`), domain).toBeNull();
    }
  });

  it('has a public-domain list the resolver and the account creator both read', () => {
    expect(PUBLIC_EMAIL_DOMAINS.has('gmail.com')).toBe(true);
    expect(PUBLIC_EMAIL_DOMAINS.has('acme-corp.com')).toBe(false);
  });

  it('returns null rather than throwing for an unusable address', () => {
    expect(accountDomain('nonsense')).toBeNull();
    expect(accountDocId(null)).toBeNull();
  });
});

describe('§29 — plus-addressing is surfaced for review and NEVER merged automatically', () => {
  it('does not treat a tagged address as the base address', () => {
    // The two mistakes are not symmetric. A missed merge leaves a visible duplicate; a wrong
    // merge writes one person's history, consent and suppression onto another's.
    expect(contactDocId('alice+news@example.com')).not.toBe(contactDocId('alice@example.com'));
  });

  it('surfaces the tag so a human can decide', () => {
    expect(plusAddressTag('alice+news@example.com')).toBe('news');
    expect(plusAddressTag('alice@example.com')).toBeNull();
    expect(suggestedBaseAddress('alice+news@example.com')).toBe('alice@example.com');
    expect(suggestedBaseAddress('alice@example.com')).toBeNull();
  });

  it('does not suggest a base address when the tag is the whole local part', () => {
    // '+news@example.com' has no base to suggest, and '' would be an invalid address.
    expect(suggestedBaseAddress('+news@example.com')).toBeNull();
  });
});

describe('§14 — a merge never turns a refusal into permission', () => {
  const base = { id: 'ct_a', organizationId: 'org1', emailKey: 'a@x.com' };
  const dupe = { id: 'ct_b', organizationId: 'org1', emailKey: 'a@x.com' };

  it('SUPPRESSION UNIONS: a signal on either record lands on the survivor', () => {
    for (const signal of SUPPRESSION_SIGNALS) {
      const value = signal.field === 'emailStatus' ? 'BOUNCED' : true;
      const plan = planContactMerge({ ...base }, { ...dupe, [signal.field]: value });
      expect(plan.ok, signal.field).toBe(true);
      if (plan.ok === false) continue;
      expect(plan.survivorPatch[signal.field], signal.field).toBe(value);
      expect(plan.inheritedSuppression).toContain(signal.label);
    }
  });

  it('CONSENT DOES NOT UNION when the duplicate is suppressed', () => {
    // A person who opted in through a form and later unsubscribed has withdrawn. Merging must
    // not resurrect the opt-in because it is recorded on a different document.
    const plan = planContactMerge(
      { ...base, consentGiven: true, consentSource: 'webform' },
      { ...dupe, unsubscribed: true }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.survivorPatch.consentGiven).toBe(false);
    expect(plan.consentRevoked).toBe(true);
    expect(plan.survivorPatch.consentRevokedReason).toBeTruthy();
  });

  it('carries consent forward only when NEITHER record is suppressed', () => {
    // Absence of a consent record on the survivor is absence of evidence, not evidence of
    // refusal, so the recorded opt-in is the better-informed of the two states.
    const plan = planContactMerge({ ...base }, { ...dupe, consentGiven: true, consentSource: 'webform' });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.survivorPatch.consentGiven).toBe(true);
    expect(plan.survivorPatch.consentSource).toBe('webform');
  });

  it('leaves the merged-away record unmailable', () => {
    // A stray writer still holding the old id must not find a record that looks sendable.
    const plan = planContactMerge({ ...base }, { ...dupe, consentGiven: true });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.duplicatePatch.consentGiven).toBe(false);
    expect(plan.duplicatePatch.supersededBy).toBe('ct_a');
    expect(plan.duplicatePatch.status).toBe('MERGED');
  });

  it('agrees with the gateway about what counts as suppression', () => {
    // If this list and ActionGateway's list drift, a merge produces a survivor the gateway
    // then considers mailable. The gateway's checks are read out of its source.
    const gateway = readFileSync('server/gateway/actionGateway.ts', 'utf8');
    for (const signal of SUPPRESSION_SIGNALS) {
      expect(gateway, `gateway does not check ${signal.field}`).toContain(
        `contactData.${signal.field}`
      );
    }
  });

  it('treats only the literal true as consent', () => {
    for (const value of ['true', 1, 'yes', {}, [], 'false', 0]) {
      expect(hasAffirmativeConsent({ consentGiven: value }), JSON.stringify(value)).toBe(false);
    }
    expect(hasAffirmativeConsent({ consentGiven: true })).toBe(true);
  });

  it('reports suppression labels for a record', () => {
    expect(isSuppressed({})).toBe(false);
    expect(isSuppressed(null)).toBe(false);
    expect(suppressionLabels({ hardBounced: true, emailStatus: 'BOUNCED' })).toEqual([
      'HARD_BOUNCE',
      'BOUNCED',
    ]);
  });
});

describe('§15 — a merge refuses the cases that would corrupt rather than combine', () => {
  const a = { id: 'ct_a', organizationId: 'org1' };

  it('REFUSES a cross-tenant merge', () => {
    const plan = planContactMerge(a, { id: 'ct_b', organizationId: 'org2' });
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.refusal.code).toBe('CROSS_TENANT');
  });

  it('REFUSES merging a record into itself', () => {
    const plan = planContactMerge(a, { id: 'ct_a', organizationId: 'org1' });
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.refusal.code).toBe('SAME_RECORD');
  });

  it('REFUSES to build a chain through an already-merged record', () => {
    // Reparenting does not follow chains, so rows would be left pointing at a record that is
    // itself superseded — the same orphan the merge exists to remove.
    const merged = { id: 'ct_b', organizationId: 'org1', supersededBy: 'ct_c' };
    expect(planContactMerge(a, merged).ok).toBe(false);
    expect(planContactMerge({ ...a, supersededBy: 'ct_z' }, { id: 'ct_b', organizationId: 'org1' }).ok).toBe(
      false
    );
  });

  it('is RESUMABLE into the same survivor, because reparenting can leave stragglers', () => {
    // A Firestore transaction cannot run a query, so the caller enumerates the rows to
    // reparent first and commits second; a row written in between still points at the
    // merged-away record. If the merge could not be re-run, repairing that would be manual.
    const survivor = { id: 'ct_a', organizationId: 'org1', mergedFrom: ['ct_b'] };
    const alreadyMerged = { id: 'ct_b', organizationId: 'org1', supersededBy: 'ct_a' };

    expect(planContactMerge(survivor, alreadyMerged).ok).toBe(false);

    const resumed = planContactMerge(survivor, alreadyMerged, { resume: true });
    expect(resumed.ok).toBe(true);
    // Re-running must not record the same source twice: that would suggest two merges happened.
    if (resumed.ok) expect(resumed.survivorPatch.mergedFrom).toEqual(['ct_b']);
  });

  it('REFUSES to resume into a DIFFERENT survivor even when asked', () => {
    // That is a chain, not a resume, and reparenting does not follow chains.
    const plan = planContactMerge(
      { id: 'ct_a', organizationId: 'org1' },
      { id: 'ct_b', organizationId: 'org1', supersededBy: 'ct_other' },
      { resume: true }
    );
    expect(plan.ok).toBe(false);
    if (plan.ok !== false) return;
    expect(plan.refusal.code).toBe('ALREADY_SUPERSEDED');
  });

  it('REFUSES records with no id', () => {
    expect(planContactMerge({ organizationId: 'org1' }, { id: 'ct_b', organizationId: 'org1' }).ok).toBe(
      false
    );
  });

  it('fills gaps from the duplicate without overwriting the survivor', () => {
    const plan = planContactMerge(
      { id: 'ct_a', organizationId: 'org1', name: 'Alice', phone: '' },
      { id: 'ct_b', organizationId: 'org1', name: 'A. Smith', phone: '555', title: 'CTO' }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(plan.survivorPatch.name).toBeUndefined();
    expect(plan.survivorPatch.phone).toBe('555');
    expect(plan.survivorPatch.title).toBe('CTO');
  });

  it('never copies structural fields from the duplicate', () => {
    const plan = planContactMerge(
      { id: 'ct_a', organizationId: 'org1' },
      { id: 'ct_b', organizationId: 'org1', version: 77, createdAt: '1999', supersededBy: '' }
    );
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    for (const field of ['id', 'organizationId', 'version', 'createdAt', 'supersededBy']) {
      expect(plan.survivorPatch[field], field).toBeUndefined();
    }
  });

  it('records where the survivor came from', () => {
    const plan = planContactMerge({ id: 'ct_a', organizationId: 'org1' }, { id: 'ct_b', organizationId: 'org1' });
    expect(plan.ok && plan.survivorPatch.mergedFrom).toEqual(['ct_b']);
  });

  it('appends to an existing merge history rather than replacing it', () => {
    const plan = planContactMerge(
      { id: 'ct_a', organizationId: 'org1', mergedFrom: ['ct_x'] },
      { id: 'ct_b', organizationId: 'org1' }
    );
    expect(plan.ok && plan.survivorPatch.mergedFrom).toEqual(['ct_x', 'ct_b']);
  });

  it('writes ISO timestamps, not millisecond counts', () => {
    const plan = planContactMerge({ id: 'ct_a', organizationId: 'org1' }, { id: 'ct_b', organizationId: 'org1' });
    expect(plan.ok).toBe(true);
    if (plan.ok === false) return;
    expect(String(plan.survivorPatch.updatedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(plan.duplicatePatch.mergedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('§18 — a thread is not joined on an attacker-supplied header alone', () => {
  const signals = { organizationId: 'org1', contactId: 'ct_alice' };

  it('REFUSES to append to another contact’s conversation on a matching reference', () => {
    // An attacker who learns a Message-ID could otherwise graft their email onto a customer's
    // thread, and the composer would draft a reply using that thread's history.
    const resolution = resolveThread(
      { ...signals, references: '<victim-thread@mail.example>' },
      { byReference: [{ conversationId: 'conv_victim', organizationId: 'org1', contactId: 'ct_bob' }] }
    );
    expect(resolution.kind).toBe('NEW');
    if (resolution.kind === 'NEW') {
      expect(resolution.rejected?.conversationId).toBe('conv_victim');
      expect(resolution.rejected?.why).toContain('different contact');
    }
  });

  it('REFUSES a provider thread id belonging to another organisation', () => {
    const resolution = resolveThread(
      { ...signals, providerThreadId: 'gmail-thread-1' },
      {
        byProviderThread: {
          conversationId: 'conv_other',
          organizationId: 'org2',
          contactId: 'ct_alice',
        },
      }
    );
    expect(resolution.kind).toBe('NEW');
    if (resolution.kind === 'NEW') expect(resolution.rejected?.why).toContain('different organisation');
  });

  it('joins the thread when the candidate is confirmed', () => {
    const resolution = resolveThread(
      { ...signals, providerThreadId: 'gmail-thread-1' },
      {
        byProviderThread: {
          conversationId: 'conv_ok',
          organizationId: 'org1',
          contactId: 'ct_alice',
        },
      }
    );
    expect(resolution).toMatchObject({
      kind: 'EXISTING',
      conversationId: 'conv_ok',
      method: 'PROVIDER_THREAD',
    });
  });

  it('falls back to the reply headers when there is no provider thread id', () => {
    const resolution = resolveThread(
      { ...signals, inReplyTo: '<a@mail.example>' },
      { byReference: [{ conversationId: 'conv_ok', organizationId: 'org1', contactId: 'ct_alice' }] }
    );
    expect(resolution).toMatchObject({ kind: 'EXISTING', method: 'HEADER_REFERENCE' });
  });

  it('starts a new conversation when nothing matches', () => {
    expect(resolveThread(signals, {}).kind).toBe('NEW');
    expect(resolveThread({ ...signals, providerThreadId: 'x' }, { byProviderThread: null }).kind).toBe(
      'NEW'
    );
  });
});

describe('§18 — reply headers are parsed, and are bounded', () => {
  it('parses the bracketed form rather than splitting on whitespace', () => {
    // A folded References header splits into fragments if you split on whitespace.
    const header = '<a@x.example>\r\n <b@x.example>\t<c@x.example>';
    expect(parseMessageIds(header)).toEqual(['a@x.example', 'b@x.example', 'c@x.example']);
  });

  it('ignores unbracketed junk and duplicates', () => {
    expect(parseMessageIds('not-an-id <a@x> <a@x> also-junk')).toEqual(['a@x']);
    expect(parseMessageIds('')).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
    expect(parseMessageIds(12345)).toEqual([]);
  });

  it('cannot be made to run away on a malformed header', () => {
    expect(parseMessageIds('<'.repeat(5000))).toEqual([]);
    expect(parseMessageIds(`<${'x'.repeat(5000)}>`)).toEqual([]);
  });

  it('BOUNDS the number of ids, because the sender controls how many arrive', () => {
    // References grows by one per reply and an attacker chooses its length, so an unbounded
    // parse is an unbounded number of datastore lookups per inbound message.
    const many = Array.from({ length: 500 }, (_, i) => `<id${i}@x.example>`).join(' ');
    const parsed = parseMessageIds(many);
    expect(parsed).toHaveLength(MAX_REFERENCES);
    // The tail is kept: the nearest ancestry is the relevant part.
    expect(parsed[parsed.length - 1]).toBe('id499@x.example');
  });

  it('tries the immediate parent before the older ancestry', () => {
    const ids = referencedMessageIds({
      organizationId: 'org1',
      contactId: 'ct_a',
      inReplyTo: '<parent@x>',
      references: '<oldest@x> <newer@x>',
    });
    expect(ids[0]).toBe('parent@x');
    expect(ids[1]).toBe('newer@x');
    expect(ids[2]).toBe('oldest@x');
  });
});
