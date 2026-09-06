import { describe, it, expect } from 'vitest';
import { normalizeEmailKey, requireEmailKey } from '../lib/emailKey';

/**
 * INVARIANTS (addendum §29 / P1.2).
 *
 * `contacts` carries UNIQUE(organization_id, email_key). That constraint means what it says
 * only if every writer derives the key identically — so the properties tested here are what
 * make the database constraint a real control rather than a decoration:
 *
 *   1. Forms of the SAME address collapse to ONE key. If they do not, the unique permits
 *      exactly the duplicate contacts it appears to prevent.
 *   2. Forms of DIFFERENT addresses never collapse. If they do, the unique merges two real
 *      people into one row, and their conversations, facts and consent state with them.
 *   3. An unusable address yields null, never the empty string. Empty collides with every
 *      other empty, so writing it as a key would merge unrelated contacts under the constraint.
 */

describe('§29 — the same address always produces the same key', () => {
  const forms = [
    'alice@example.com',
    'Alice@Example.com',
    'ALICE@EXAMPLE.COM',
    '  alice@example.com  ',
    'Alice Smith <alice@example.com>',
    'Alice Smith <Alice@Example.COM>',
    '<alice@example.com>',
    '"Smith, Alice" <ALICE@example.com>',
  ];

  for (const form of forms) {
    it(`${JSON.stringify(form)} -> alice@example.com`, () => {
      expect(normalizeEmailKey(form)).toBe('alice@example.com');
    });
  }

  it('all forms agree with each other', () => {
    const keys = new Set(forms.map((f) => normalizeEmailKey(f)));
    expect(keys.size).toBe(1);
  });
});

describe('§29 — different addresses never collapse into one key', () => {
  const distinct = [
    'alice@example.com',
    'alice@example.org',
    'alice.smith@example.com',
    'bob@example.com',
    'alice+news@example.com', // Plus-addressing is NOT folded: whether it is the same mailbox
    // is provider-specific, and folding it would merge two people at
    // any provider that treats them separately. Deciding this is P1.5.
  ];

  it('produces a distinct key for each', () => {
    const keys = distinct.map((d) => normalizeEmailKey(d));
    expect(new Set(keys).size).toBe(distinct.length);
  });
});

describe('§14 — an unusable address is null, never an empty key', () => {
  const unusable = [
    '',
    '   ',
    'not-an-email',
    '@example.com',
    'alice@',
    'alice@@example.com',
    'alice@one@two.com',
    '<>',
    'Display Name <>',
  ];

  for (const value of unusable) {
    it(`REJECTS ${JSON.stringify(value)}`, () => {
      expect(normalizeEmailKey(value)).toBeNull();
      // Specifically not '': an empty key collides with every other empty key, so a unique
      // constraint on it would merge unrelated contacts into a single row.
      expect(normalizeEmailKey(value)).not.toBe('');
    });
  }

  it('rejects non-strings rather than coercing them', () => {
    for (const value of [null, undefined, 42, {}, ['a@b.com']]) {
      expect(normalizeEmailKey(value)).toBeNull();
    }
  });

  it('requireEmailKey throws rather than returning a placeholder', () => {
    expect(() => requireEmailKey('not-an-email')).toThrow();
    expect(requireEmailKey('Alice <ALICE@example.com>')).toBe('alice@example.com');
  });
});

describe('§36 — normalisation is linear in input size', () => {
  it('does not degrade on a long adversarial input', () => {
    // Inbound email is attacker-controlled, and this repository has already shipped one
    // quadratic regex on that path (evaluateEmailUnderstandingRuleBased, fixed under P2:
    // 40k characters took 986ms). A bracket-matching pattern is the obvious place for the
    // same mistake, so it is measured rather than assumed.
    const hostile = '<'.repeat(50_000) + 'alice@example.com';

    const started = Date.now();
    normalizeEmailKey(hostile);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(250);
  });
});
