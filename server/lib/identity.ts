import { createHash } from 'node:crypto';
import { normalizeEmailKey } from './emailKey';

export { normalizeEmailKey, requireEmailKey } from './emailKey';

/**
 * P1.5 — IDENTITY, DEDUPLICATION AND MERGE (addendum §29, §15).
 *
 * WHAT WAS WRONG
 * --------------
 * Seven handlers created contacts with `addDoc`, which asks Firestore for a *fresh random
 * document id*. Posting the same person twice produced two documents, and nothing anywhere
 * noticed. The PostgreSQL side does carry `contacts_org_email_key_unique`, but PostgreSQL is
 * not the datastore this deployment runs on, so that constraint has never once been consulted
 * on a live write.
 *
 * The consequence is not untidy data. `ActionGateway` decides whether a person may be emailed
 * by loading ONE contact document by id and reading `suppressed` / `unsubscribed` /
 * `hardBounced` / `complained` / `consentGiven` off it. With duplicates, those flags live on
 * whichever copy happened to receive the unsubscribe — so a person who unsubscribed on
 * document A is still mailable through document B. §14 says unknown consent must never
 * default to permission; duplicates turn a *known* refusal back into an unknown one.
 *
 * THE RULE
 * --------
 * The document id IS the uniqueness constraint. Derive it from the normalised email so the
 * same person deterministically lands on the same document, and create with a transaction
 * that refuses when the document already exists. Then "two contacts for one person" is not
 * something to detect and clean up afterwards — it is unrepresentable.
 */

/**
 * Domains where an address belongs to an individual rather than to an organisation.
 *
 * This list previously lived inside IdentityResolverService as a five-entry array, which is
 * how a shared rule quietly stops being shared. It matters in two places that must agree: an
 * account must NOT be created for a free-mail domain (otherwise every gmail.com contact joins
 * one "account" containing strangers), and domain-based identity matching must not fire on
 * one (otherwise any gmail address resolves to any other gmail contact's account).
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.uk',
  'hotmail.com',
  'hotmail.co.uk',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'mail.com',
  'yandex.ru',
  'zoho.com',
  'fastmail.com',
  'tutanota.com',
  'hey.com',
  'qq.com',
  '163.com',
  '126.com',
]);

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/**
 * The scheme tag baked into every derived id.
 *
 * If the normalisation rule ever changes, ids derived under the old rule must remain
 * recognisable as such — otherwise a normalisation change silently orphans every existing
 * document while appearing to work perfectly on new ones. Bumping this tag is the visible,
 * deliberate act that a normalisation change requires, and it forces a migration to be
 * written rather than assumed.
 */
export const ID_SCHEME = 'c1';

/** 128 bits of SHA-256. The birthday bound is 2^64 keys per tenant; the corpus is contacts. */
const ID_HASH_CHARS = 32;

function derivedId(prefix: string, material: string): string {
  const digest = createHash('sha256').update(material, 'utf8').digest('hex');
  return `${prefix}_${ID_SCHEME}_${digest.slice(0, ID_HASH_CHARS)}`;
}

/**
 * The Firestore document id for a contact, derived from their normalised address.
 *
 * A hash rather than the address itself, for three reasons. Firestore ids may not contain
 * a forward slash, may not be '.' or '..', and may not be wrapped in double underscores —
 * and a forward slash is a legal character in an email local part, so the raw address is not
 * a safe id. Ids also appear in logs, error messages and URLs, and an email address is
 * personal data that does not belong in any of them. And a fixed-length id cannot exceed the
 * 1500-byte limit no matter what arrives.
 *
 * Throws on an unusable address. There is no id for "no identity", and inventing one — an
 * empty string, or the literal 'unknown' — gives every unidentifiable contact the SAME id,
 * which does not merely fail to deduplicate but actively merges strangers.
 */
export function contactDocId(email: unknown): string {
  const key = normalizeEmailKey(email);
  if (key === null) {
    throw new IdentityError(
      `Cannot derive a contact id from ${JSON.stringify(email)}: no usable email address.`
    );
  }
  return derivedId('ct', key);
}

/** The same derivation, returning null instead of throwing where absence is a data condition. */
export function tryContactDocId(email: unknown): string | null {
  const key = normalizeEmailKey(email);
  return key === null ? null : derivedId('ct', key);
}

/**
 * The organisation domain for an address, or null when the address is a personal one.
 *
 * Null is the answer for free-mail providers, and it is the important half of this function:
 * grouping every gmail.com address into one account record would place unrelated people in a
 * shared company history that the reply composer then reads as context.
 */
export function accountDomain(email: unknown): string | null {
  const key = normalizeEmailKey(email);
  if (key === null) return null;
  const domain = key.slice(key.indexOf('@') + 1);
  if (domain.length === 0) return null;
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) return null;
  return domain;
}

/** The Firestore document id for an account, derived from its domain. Null for personal mail. */
export function accountDocId(email: unknown): string | null {
  const domain = accountDomain(email);
  return domain === null ? null : derivedId('ac', domain);
}

/**
 * PLUS-ADDRESSING AND DOTS ARE DELIBERATELY NOT STRIPPED.
 *
 * `alice+news@example.com` and `alice@example.com` are the same mailbox at Gmail. They are
 * different mailboxes at a provider that treats '+' as an ordinary local-part character, and
 * such providers exist. The same is true of dots.
 *
 * The two possible mistakes here are not symmetric. Failing to merge two records for one
 * person leaves a duplicate — visible, correctable, and caught by the merge operation. Merging
 * two records for different people writes one person's conversation history, consent state and
 * suppression flags onto another's, and the reply composer then drafts mail to the second
 * person using the first person's transcript. That is unrecoverable and invisible.
 *
 * So the rule is to normalise only what is unambiguously case- and whitespace-insensitive per
 * RFC 5321 (the domain, and the surrounding whitespace), and to leave anything provider-
 * specific alone. The functions below exist to make a tag VISIBLE to a human reviewing
 * possible duplicates; they are not used to derive ids, and must not be.
 */
export function plusAddressTag(email: unknown): string | null {
  const key = normalizeEmailKey(email);
  if (key === null) return null;
  const local = key.slice(0, key.indexOf('@'));
  const plus = local.indexOf('+');
  if (plus < 0) return null;
  return local.slice(plus + 1);
}

/**
 * The address a plus-tag suggests, for review purposes only.
 *
 * A caller may show this to an operator as "this may be the same person as X". No writer may
 * use it to choose a document id — see the note above on which mistake is recoverable.
 */
export function suggestedBaseAddress(email: unknown): string | null {
  const key = normalizeEmailKey(email);
  if (key === null) return null;
  const at = key.indexOf('@');
  const local = key.slice(0, at);
  const plus = local.indexOf('+');
  if (plus <= 0) return null;
  return `${local.slice(0, plus)}${key.slice(at)}`;
}

/**
 * Is this address at a free-mail provider — that is, an individual rather than an organisation?
 *
 * Returns null when the address is not usable at all, which is a DIFFERENT answer from "not
 * free-mail" and must not be collapsed into one. `accountDomain` returns null for both, which
 * is right for its own question and wrong for this one: a caller asking "may I treat this as a
 * business recipient?" needs "no" for a gmail address and "I cannot tell" for `not-an-email`,
 * and answering "no" to both would let an unparseable address pass as a business one.
 *
 * The single owner of this question. `server/domain/lawfulBasis.ts` asks it to decide whether
 * legitimate interest is available, and a second copy of the domain list is how the two would
 * stop agreeing.
 */
export function isFreeMailAddress(email: unknown): boolean | null {
  const key = normalizeEmailKey(email);
  if (key === null) return null;
  const domain = key.slice(key.indexOf('@') + 1);
  if (domain.length === 0) return null;
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}
