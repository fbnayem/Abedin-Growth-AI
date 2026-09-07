import { describe, it, expect } from 'vitest';
import {
  collection,
  doc,
  where,
  orderBy,
  limit,
  query,
  compileQuery,
  tenantOf,
  assertNoUndefined,
  StorePathError,
  StoreValueError,
} from '../store';

/**
 * INVARIANTS FOR THE DOCUMENT STORE (addendum §4, §14, §18).
 *
 * The store replaced Firestore, and with it the two-datastore split where the producer wrote
 * PostgreSQL while the consumer read Firestore. Every suppression check and campaign guard in
 * this repository now enforces against the store these tests describe, so what is proved here
 * is load-bearing for all of them.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE
 * -----------------------------------
 * CI has no database. So this file proves the PURE half — which tenant a path belongs to, what
 * SQL a query becomes, which values are refused — by calling the real functions, not copies of
 * their rules.
 *
 * It cannot prove the store reads and writes correctly, because that needs PostgreSQL. That
 * proof is `scripts/store-verify.ts`, run deliberately against the live instance in the same
 * way `scripts/db-verify.ts` is, and its output is recorded in the status document. Saying so
 * here rather than writing a suite that skips silently: a green run that touched nothing is
 * the exact failure this codebase's audit exists to catch.
 */

describe('§4 — a path cannot be made to address another tenant', () => {
  it('a collection path must alternate collection/document', () => {
    // `organizations/acme` names a DOCUMENT. Reading it as a collection is how a query meant
    // for one tenant's contacts silently spans every tenant.
    expect(() => collection(null, 'organizations/acme')).toThrow(StorePathError);
    expect(() => collection(null, 'organizations/acme/contacts')).not.toThrow();
    expect(() => collection(null, 'organizations/acme/conversations/c1/messages')).not.toThrow();
  });

  it('refuses the segments that change the shape of a path', () => {
    for (const bad of [
      'organizations//contacts',
      'organizations/../contacts',
      'organizations/./contacts',
      '',
    ]) {
      expect(() => collection(null, bad), `accepted ${JSON.stringify(bad)}`).toThrow(
        StorePathError
      );
    }
  });

  it('refuses a document id that would traverse out of its collection', () => {
    const c = 'organizations/acme/contacts';
    expect(() => doc(null, c, '../../oauth_connections')).toThrow(StorePathError);
    expect(() => doc(null, c, '..')).toThrow(StorePathError);
    expect(() => doc(null, c, '.')).toThrow(StorePathError);
    expect(() => doc(null, c, '')).toThrow(StorePathError);
    expect(() => doc(null, c, 'contact_1')).not.toThrow();
  });

  it('a non-string path or id is refused rather than coerced', () => {
    // `String(undefined)` is 'undefined', which is a perfectly valid document id. Coercion is
    // how a failed lookup becomes a successful read of the wrong document.
    expect(() => collection(null, undefined as never)).toThrow(StorePathError);
    expect(() => doc(null, 'organizations/acme/contacts', undefined as never)).toThrow(
      StorePathError
    );
    expect(() => doc(null, 'organizations/acme/contacts', 42 as never)).toThrow(StorePathError);
  });
});

describe('doc() accepts both call shapes the codebase uses', () => {
  /**
   * `doc(store, path, id)` and `doc(collectionRef, id)` are both in use. An earlier double in
   * the chaos suite handled only the two-argument form, and every path came out generated, so
   * nothing matched and every test failed identically — which reads like broken code rather
   * than a broken harness. The variadic form is what makes both shapes work.
   */
  it('doc(store, path, id)', () => {
    const ref = doc(null, 'organizations/acme/contacts', 'c1');
    expect(ref.path).toBe('organizations/acme/contacts');
    expect(ref.id).toBe('c1');
  });

  it('doc(collectionRef, id)', () => {
    const ref = doc(collection(null, 'organizations/acme/contacts'), 'c1');
    expect(ref.path).toBe('organizations/acme/contacts');
    expect(ref.id).toBe('c1');
  });

  it('doc(collectionRef) generates an id rather than addressing nothing', () => {
    const ref = doc(collection(null, 'organizations/acme/contacts'));
    expect(ref.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('the two shapes address the same document', () => {
    const viaPath = doc(null, 'organizations/acme/contacts', 'c1');
    const viaRef = doc(collection(null, 'organizations/acme/contacts'), 'c1');
    expect(viaRef).toEqual(viaPath);
  });
});

describe('§4 — the tenant is derived from the path, so it cannot disagree with it', () => {
  it('an organisation path yields its organisation', () => {
    expect(tenantOf('organizations/acme/contacts')).toBe('acme');
    expect(tenantOf('organizations/acme/conversations/c1/messages')).toBe('acme');
  });

  it('a top-level collection has no tenant', () => {
    // `oauth_connections` and `system_settings` are genuinely tenantless. This is why the
    // column is nullable, and schemaTenancy.invariant.test.ts asserts that on the schema.
    expect(tenantOf('oauth_connections')).toBeNull();
    expect(tenantOf('system_settings')).toBeNull();
  });

  it('a collection merely NAMED organizations is not a tenant path', () => {
    // Two segments: this is the organisations collection itself, not a path inside one.
    expect(tenantOf('organizations')).toBeNull();
  });

  it('the tenant is the second segment, not any segment that looks like one', () => {
    expect(tenantOf('somethingelse/acme/contacts')).toBeNull();
  });
});

describe('§18 — a query compiles to parameters, never to SQL text', () => {
  const C = collection(null, 'organizations/acme/outbox');

  it('a field name is a parameter, so it cannot become syntax', () => {
    // Collection names reach this from route parameters in server.ts. A field name spliced
    // into SQL text is an injection; a field name bound as a parameter is a string.
    const hostile = "status'; DROP TABLE documents; --";
    const { text, values } = compileQuery(query(C, where(hostile, '==', 'PENDING')));
    expect(text).not.toContain('DROP TABLE');
    expect(values).toContain(hostile);
  });

  it('the collection path is a parameter too', () => {
    const { text, values } = compileQuery(query(C));
    expect(values[0]).toBe('organizations/acme/outbox');
    expect(text).toContain('path = $1');
    expect(text).not.toContain('organizations/acme/outbox');
  });

  it('equality compares JSON values, not their text rendering', () => {
    // `data->>'x'` renders everything as text, so `true` would equal the string "true" and
    // `1` would equal "1". `data->'x'` keeps the type. The distinction decides whether a job
    // with status stored as a number is drained by a query for a string status.
    const { text } = compileQuery(query(C, where('status', '==', 'PENDING')));
    expect(text).toContain('data -> $2 = $3::jsonb');
    expect(text).not.toContain('->>' + " $2");
  });

  it('the value is JSON-encoded, so its type survives', () => {
    expect(compileQuery(query(C, where('active', '==', true))).values[2]).toBe('true');
    expect(compileQuery(query(C, where('active', '==', 'true'))).values[2]).toBe('"true"');
    expect(compileQuery(query(C, where('n', '==', 1))).values[2]).toBe('1');
    expect(compileQuery(query(C, where('n', '==', null))).values[2]).toBe('null');
  });

  it('a limit is a parameter and appears in the SQL', () => {
    const { text, values } = compileQuery(query(C, limit(25)));
    expect(text).toMatch(/LIMIT \$\d+$/);
    expect(values).toContain(25);
  });

  it('ordering is explicit in both directions', () => {
    expect(compileQuery(query(C, orderBy('createdAt', 'desc'))).text).toContain('DESC');
    expect(compileQuery(query(C, orderBy('createdAt', 'asc'))).text).toContain('ASC');
  });

  it('an unordered query is still deterministic', () => {
    // Without an ORDER BY, PostgreSQL may return rows in any order, and a claim loop that
    // takes the first N would see a different N on each run. `limit(1)` on an unordered
    // query has to mean something stable.
    expect(compileQuery(query(C)).text).toContain('ORDER BY id ASC');
  });

  it('several constraints combine rather than replace one another', () => {
    const { text, values } = compileQuery(
      query(C, where('status', '==', 'PENDING'), where('orgId', '==', 'acme'), limit(5))
    );
    expect(text.match(/data -> \$\d+ = \$\d+::jsonb/g)).toHaveLength(2);
    expect(values).toContain(5);
  });

  it('a query built from a query keeps the earlier constraints', () => {
    const first = query(C, where('status', '==', 'PENDING'));
    const second = query(first, limit(3));
    expect(second.constraints).toHaveLength(2);
  });
});

describe('§14 — an operator or value the store cannot honour is refused, not ignored', () => {
  const C = collection(null, 'organizations/acme/outbox');

  it('an unsupported operator throws instead of being silently dropped', () => {
    // Every query in this repository is an equality match. If one ever is not, the failure
    // must be loud: a range filter quietly ignored returns MORE rows than asked for, and the
    // caller cannot tell.
    expect(() => where('sends', '>=' as never, 3)).toThrow(StoreValueError);
    expect(() => where('status', 'in' as never, ['A'])).toThrow(StoreValueError);
  });

  it('where(field, ==, undefined) is refused', () => {
    // It matches nothing, and it almost always means the value failed to load. Silently
    // matching nothing turns a failed lookup into an empty result set that reads as "none".
    expect(() => where('status', '==', undefined)).toThrow(StoreValueError);
  });

  it('a nonsensical limit is refused', () => {
    expect(() => limit(0)).toThrow(StoreValueError);
    expect(() => limit(-1)).toThrow(StoreValueError);
    expect(() => limit(1.5)).toThrow(StoreValueError);
    expect(() => limit(NaN)).toThrow(StoreValueError);
    expect(() => limit(10)).not.toThrow();
  });
});

describe('§14 — undefined is refused at every depth, because JSON would drop it silently', () => {
  it('a top-level undefined is refused', () => {
    expect(() => assertNoUndefined({ a: undefined }, 'doc')).toThrow(StoreValueError);
  });

  it('a nested undefined is refused', () => {
    expect(() => assertNoUndefined({ a: { b: { c: undefined } } }, 'doc')).toThrow(
      StoreValueError
    );
  });

  it('an undefined inside an array is refused', () => {
    expect(() => assertNoUndefined({ a: [1, undefined, 3] }, 'doc')).toThrow(StoreValueError);
  });

  it('the message names the field, so the fix does not need a search', () => {
    expect(() => assertNoUndefined({ payload: { to: undefined } }, 'doc')).toThrow(
      /doc\.payload\.to/
    );
  });

  it('null is allowed, because "known to be absent" is a real value', () => {
    // The distinction matters: `suppressed: null` is a record that says nothing, and §14 turns
    // on being able to tell that from `suppressed: false`.
    expect(() => assertNoUndefined({ a: null, b: [null], c: { d: null } }, 'doc')).not.toThrow();
  });

  it('dates and empty containers are allowed', () => {
    expect(() => assertNoUndefined({ at: new Date(0), xs: [], o: {} }, 'doc')).not.toThrow();
  });
});
