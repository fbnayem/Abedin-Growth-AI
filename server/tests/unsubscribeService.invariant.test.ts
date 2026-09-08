import { describe, it, expect, beforeEach, vi } from 'vitest';
import { unsubscribeToken, MIN_SECRET_LENGTH } from '../domain/unsubscribe';

/**
 * INVARIANTS FOR RECORDING AN UNSUBSCRIBE (addendum S26).
 *
 * `actionGateway.ts:645` refuses to send when `contactData.unsubscribed === true`. Nothing in
 * this repository ever wrote that field. This is the writer, and these are the properties that
 * make it worth having rather than merely present.
 */

/** The whole document store, keyed on `path/id`, with the merge semantics the real one has. */
const documents: Record<string, Record<string, unknown>> = {};
let storeAvailable = true;
let writeFails = false;

vi.mock('../store', () => {
  const key = (ref: any) => `${ref.path}/${ref.id}`;
  return {
    get store() {
      return storeAvailable ? { pool: {} } : null;
    },
    doc: (_first: any, path: string, id: string) => ({ kind: 'document', path, id }),
    setDoc: async (ref: any, data: Record<string, unknown>, options?: { merge?: boolean }) => {
      if (writeFails) throw new Error('write failed');
      const k = key(ref);
      // The real store's `{ merge: true }` CREATES when the document is absent — the property
      // this whole module depends on.
      documents[k] = options?.merge === true ? { ...(documents[k] ?? {}), ...data } : { ...data };
    },
  };
});

const { recordUnsubscribe } = await import('../services/unsubscribe.service');

const SECRET = 'u'.repeat(MIN_SECRET_LENGTH);
const ENV = { UNSUBSCRIBE_SECRET: SECRET, APP_URL: 'https://app.example.com' };
const CONFIG = { secret: SECRET, appUrl: 'https://app.example.com' };
const AT = '2026-09-08T12:00:00.000Z';
const CONTACT = 'organizations/acme/contacts/c1';

const tokenFor = (orgId: string, contactId: string) =>
  unsubscribeToken({ orgId, contactId }, CONFIG)!;

beforeEach(() => {
  for (const k of Object.keys(documents)) delete documents[k];
  storeAvailable = true;
  writeFails = false;
});

describe('1. a valid opt-out is recorded where the gateway reads it', () => {
  it('writes the exact field the send path refuses on', () => {
    return recordUnsubscribe({
      token: tokenFor('acme', 'c1'),
      at: AT,
      source: 'ONE_CLICK',
      env: ENV,
    }).then((result) => {
      expect(result.ok).toBe(true);
      // `unsubscribed`, not `optedOut` or `suppressed`. The gateway reads this name; a
      // different one would be a control that records something nothing enforces.
      expect(documents[CONTACT].unsubscribed).toBe(true);
      expect(documents[CONTACT].unsubscribedAt).toBe(AT);
      expect(documents[CONTACT].unsubscribeSource).toBe('ONE_CLICK');
    });
  });

  it('records which route it came through', async () => {
    await recordUnsubscribe({
      token: tokenFor('acme', 'c1'),
      at: AT,
      source: 'CONFIRMED_FORM',
      env: ENV,
    });
    // RFC 8058 one-click and a person pressing a button are different evidence about intent,
    // and an audit that cannot tell them apart cannot answer a dispute about either.
    expect(documents[CONTACT].unsubscribeSource).toBe('CONFIRMED_FORM');
  });

  /**
   * THE PROPERTY THAT DECIDED THE WRITE SHAPE.
   *
   * A contact record that was deleted, or that never existed, must not swallow an opt-out. The
   * merging set CREATES, so the flag lands on a document of its own and the gateway — which
   * separately refuses to send to a contact it cannot find — now also has the explicit fact.
   *
   * The alternative, requiring the contact to exist, discards the one signal a recipient is
   * entitled to have honoured, in precisely the case where the system's own bookkeeping is
   * already wrong.
   */
  it('an unsubscribe for a contact that does not exist still lands', async () => {
    expect(documents['organizations/acme/contacts/ghost']).toBeUndefined();
    const result = await recordUnsubscribe({
      token: tokenFor('acme', 'ghost'),
      at: AT,
      source: 'ONE_CLICK',
      env: ENV,
    });
    expect(result.ok).toBe(true);
    expect(documents['organizations/acme/contacts/ghost'].unsubscribed).toBe(true);
  });

  it('merges rather than replacing, so the contact record survives', async () => {
    documents[CONTACT] = { email: 'a@example.com', consentGiven: true, country: 'GB' };
    await recordUnsubscribe({ token: tokenFor('acme', 'c1'), at: AT, source: 'ONE_CLICK', env: ENV });
    expect(documents[CONTACT].email).toBe('a@example.com');
    expect(documents[CONTACT].country).toBe('GB');
    expect(documents[CONTACT].unsubscribed).toBe(true);
  });

  it('is idempotent — a provider retry is not a different answer', async () => {
    const token = tokenFor('acme', 'c1');
    await recordUnsubscribe({ token, at: AT, source: 'ONE_CLICK', env: ENV });
    const second = await recordUnsubscribe({ token, at: '2026-09-09T00:00:00.000Z', source: 'ONE_CLICK', env: ENV });
    expect(second.ok).toBe(true);
    expect(documents[CONTACT].unsubscribed).toBe(true);
  });

  it('writes to the tenant the token names, not to a caller-supplied one', async () => {
    // The token is the only statement of tenancy on this request. There is no session.
    await recordUnsubscribe({ token: tokenFor('other', 'c1'), at: AT, source: 'ONE_CLICK', env: ENV });
    expect(documents['organizations/other/contacts/c1'].unsubscribed).toBe(true);
    expect(documents[CONTACT]).toBeUndefined();
  });
});

describe('2. nothing is written for a request that did not prove itself', () => {
  it('a forged, tampered or absent token writes nothing', async () => {
    const real = tokenFor('acme', 'c1');
    for (const bad of [
      undefined,
      '',
      'garbage',
      `${real}x`,
      real.replace(/.$/, 'A'),
      real.split('.').reverse().join('.'),
    ]) {
      const result = await recordUnsubscribe({ token: bad, at: AT, source: 'ONE_CLICK', env: ENV });
      expect(result.ok, `accepted ${JSON.stringify(bad)}`).toBe(false);
      expect(result.ok === false && result.code).toBe('INVALID_TOKEN');
    }
    expect(Object.keys(documents)).toEqual([]);
  });

  it('one message for every way a token can fail', async () => {
    // "Signature does not verify" and "unrecognised version" are useful in a log and are an
    // oracle in a response body: they tell somebody probing which half of their guess was
    // wrong. The specific reason is logged; the caller gets one sentence.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await recordUnsubscribe({ token: 'v9.aaa.bbb', at: AT, source: 'ONE_CLICK', env: ENV });
    const b = await recordUnsubscribe({ token: 'v1.aaa.bbb', at: AT, source: 'ONE_CLICK', env: ENV });
    expect(a.ok === false && a.message).toBe(b.ok === false && b.message);
    expect(warn.mock.calls.map(String).join(' ')).toMatch(/version|signature/i);
    warn.mockRestore();
  });

  it('an unconfigured deployment refuses rather than pretending', async () => {
    const result = await recordUnsubscribe({
      token: tokenFor('acme', 'c1'),
      at: AT,
      source: 'ONE_CLICK',
      env: { APP_URL: 'https://app.example.com' },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('NOT_CONFIGURED');
    expect(Object.keys(documents)).toEqual([]);
  });
});

describe('3. an unsubscribe that was not recorded is not reported as one', () => {
  /**
   * A recipient told "you have been unsubscribed" will not press it again. If nothing was
   * written, the next campaign reaches them anyway and they have no reason to believe the
   * control is broken — they press the spam button instead.
   */
  it('an unavailable datastore is a failure, not a success', async () => {
    storeAvailable = false;
    const result = await recordUnsubscribe({
      token: tokenFor('acme', 'c1'),
      at: AT,
      source: 'ONE_CLICK',
      env: ENV,
      store: null,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.code).toBe('STORE_UNAVAILABLE');
    expect(result.ok === false && result.message).toMatch(/NOT been applied/i);
  });

  it('a failing write propagates rather than being swallowed', async () => {
    // `markFailed` in the outbox service catches and logs, which is right there because the
    // job survives. Here there is no durable record of the attempt at all, so a swallowed
    // error is an opt-out that silently never happened.
    writeFails = true;
    await expect(
      recordUnsubscribe({ token: tokenFor('acme', 'c1'), at: AT, source: 'ONE_CLICK', env: ENV })
    ).rejects.toThrow();
  });
});
