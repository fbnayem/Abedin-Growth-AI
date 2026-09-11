/**
 * Reading one field off a stored document, without asserting what it is.
 *
 * `DocumentSnapshot.data()` returns `Record<string, unknown>` — deliberately, because a document is
 * whatever was written to it, possibly by an older build. Eight call sites reached for `as any` to
 * get past that:
 *
 *     const status = (snap.data() as any)?.status;
 *     const raw = (snap.data() as any)?.inboundVersion;
 *     const contactData = contactSnap.data() as any;
 *
 * The cast does not make the value a string. It makes the compiler stop asking, and then every
 * comparison downstream is unchecked — which is how `d.accessToken` came to be compared against
 * `'mock_token'` while holding a number, a comparison that could never match on a value that could
 * never work.
 *
 * `fieldOf` asks instead. It returns `undefined` for a missing field and for a value read off a
 * non-object, so the caller's own coercion — `Number(raw)`, `=== 'ACTIVE'`, a suppression flag
 * check — stays exactly where it was and stays checked.
 */

/**
 * The value stored at `key`, or `undefined`.
 *
 * `hasOwnProperty` rather than `in` or a bare index: `data.toString` is a function inherited from
 * the prototype, and a document that does not carry `status` must not read one off `Object`.
 */
export function fieldOf(data: unknown, key: string): unknown {
  if (data === null || typeof data !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(data, key)) return undefined;
  return (data as Record<string, unknown>)[key];
}

/** The value at `key` when it is a string, and `null` otherwise — including when it is absent. */
export function stringField(data: unknown, key: string): string | null {
  const value = fieldOf(data, key);
  return typeof value === 'string' ? value : null;
}

/**
 * The value at `key` when it is a finite number, and `null` otherwise.
 *
 * A numeric STRING answers null: this is for fields the system writes as numbers, and accepting
 * `"3"` would mean a document written by something else decides a version comparison.
 */
export function numberField(data: unknown, key: string): number | null {
  const value = fieldOf(data, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** True only when the field is literally `true`. Anything else — absent, "true", 1 — is false. */
export function flagField(data: unknown, key: string): boolean {
  return fieldOf(data, key) === true;
}
