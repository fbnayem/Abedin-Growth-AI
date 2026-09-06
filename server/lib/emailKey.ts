/**
 * P1.2 — The normalised email key.
 *
 * `contacts.email_key` carries the composite unique `(organization_id, email_key)`, and that
 * constraint only means what it says if every writer derives the key the same way. A unique on
 * the raw address permits exactly the duplicates it appears to prevent: `Alice@Example.com `
 * and `alice@example.com` are different strings and the same person.
 *
 * This is deliberately ONE function in ONE place. Two subtly different normalisations are
 * worse than none, because the constraint then silently stops applying to whichever writer
 * disagrees. The fuller identity work — display-name stripping, plus-addressing policy,
 * provider-specific rules, and the deterministic document id that enforces the same
 * uniqueness on the Firestore side — is P1.5, and it belongs in this module when it lands.
 */

/**
 * Extract the address from a display-name form and normalise it for comparison.
 *
 *   'Alice Smith <Alice@Example.COM>' -> 'alice@example.com'
 *   '  ALICE@example.com  '           -> 'alice@example.com'
 *
 * Returns null when there is no usable address, because an empty string is a value that
 * collides with every other empty string: making it the key would merge unrelated contacts
 * into one row under the unique constraint.
 */
export function normalizeEmailKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  // A display-name form carries the address in angle brackets. The character class excludes
  // '>' so this cannot run away over the rest of the string.
  const angled = raw.match(/<([^<>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();

  if (candidate.length === 0) return null;

  // One '@', with something either side. Not RFC 5322 validation — the point is to reject
  // values that cannot be a stable identity key, not to police deliverability.
  const at = candidate.indexOf('@');
  if (at <= 0 || at !== candidate.lastIndexOf('@') || at === candidate.length - 1) return null;

  return candidate;
}

/**
 * The same normalisation, for callers that treat an unusable address as a programming error
 * rather than a data condition.
 */
export function requireEmailKey(raw: unknown): string {
  const key = normalizeEmailKey(raw);
  if (key === null) {
    throw new Error(`Cannot derive an email key from ${JSON.stringify(raw)}.`);
  }
  return key;
}
