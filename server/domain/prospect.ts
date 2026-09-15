import { neutralizeCsvValue } from '../../shared/lib/csvSafety';
import { derivedProspectId, normalizeEmailKey } from '../lib/identity';
import { normaliseCountry } from './lawfulBasis';

/**
 * A PERSON WE CANNOT YET EMAIL (§14, §18).
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * A contact's identity in this system IS its email address:
 *
 *     export function tryContactDocId(email: unknown): string | null {
 *       const key = normalizeEmailKey(email);
 *       return key === null ? null : derivedId('ct', key);
 *     }
 *
 * That derivation is load-bearing well beyond the id. Deduplication, the suppression list, the
 * `emailKey` lookups, the unsubscribe token and the outbound Message-ID used for §32
 * reconciliation are all built on it. `validateCandidate` refuses `NO_EMAIL` because a contact
 * without one is a record none of those mechanisms can address.
 *
 * LinkedIn gives you a name, a role, an employer and a profile URL. It does not generally give
 * you an email. So a LinkedIn profile CANNOT be a contact here — and the tempting fix, inventing
 * a placeholder address, is the worst available option: it would put a record the lawful basis
 * gate cannot reason about into the same collection as records it can, which is how a gate stops
 * being trustworthy. A placeholder is also indistinguishable from a real address six months later.
 *
 * A prospect is therefore a SEPARATE record type in a separate collection, identified by the
 * canonical profile URL, carrying no email field at all, and reachable by no send path. It
 * becomes a contact through `promoteProspect`, which is the moment an address is found — and
 * that goes through `validateCandidate` and `ingestRecords` like every other source.
 *
 * `PROSPECT_FIELDS` HAS NO `email`, AND SUPPLYING ONE IS A REFUSAL
 * ---------------------------------------------------------------
 * Not an ignore. `validateCandidate` deliberately IGNORES unrecognised keys, on the argument that
 * an extra field is usually version skew while a silent write is a security problem. The
 * reasoning inverts here: a caller who has an email and is calling the prospect path has made a
 * routing mistake, and silently dropping the one field that would have made this a real contact
 * would leave them believing it had been stored. So it refuses, and says which path to use.
 */

/** Per-value length, matching the bound the contact validator already enforces. */
export const MAX_PROSPECT_FIELD = 500;

/** The headline is LinkedIn's own free text and runs longer than a job title. */
export const MAX_PROSPECT_HEADLINE = 2_000;

export const MAX_PROSPECT_NOTES = 10_000;

/**
 * What a prospect may carry.
 *
 * Absent by design and not by oversight: `email` (see the header), and every field a contact
 * record uses to decide whether it may be mailed — `consentGiven`, `suppressed`, `unsubscribed`,
 * `hardBounced`, `complained`, `lawfulBasis`, `liaId`, `article14NoticeSentAt`. A prospect has no
 * lawful basis because a prospect is not contactable; giving it somewhere to put one would invite
 * the question of whether it could be.
 */
export const PROSPECT_FIELDS = [
  'profileUrl',
  'name',
  'firstName',
  'lastName',
  'headline',
  'title',
  'companyName',
  'companyWebsite',
  'companyProfileUrl',
  'industry',
  'country',
  'location',
  'employeeCount',
  'notes',
] as const;

export type ProspectField = (typeof PROSPECT_FIELDS)[number];

export type ProspectRefusalCode =
  | 'NO_PROFILE_URL'
  | 'BAD_PROFILE_URL'
  | 'NOT_LINKEDIN'
  | 'NOT_A_PROFILE'
  | 'COMPANY_NOT_PERSON'
  | 'HAS_EMAIL'
  | 'FIELD_TOO_LONG'
  | 'BAD_COUNTRY';

export interface ValidProspect {
  /** The canonical profile URL. The identity of this record. */
  readonly profileUrl: string;
  /** The derived document id, from the canonical URL. */
  readonly prospectId: string;
  /** Neutralised, length-checked values for allowlisted fields only. Never an address. */
  readonly fields: Readonly<Record<string, string>>;
}

export type ProspectOutcome =
  | { readonly ok: true; readonly prospect: ValidProspect }
  | { readonly ok: false; readonly code: ProspectRefusalCode; readonly message: string };

/**
 * Is this host LinkedIn?
 *
 * `endsWith('linkedin.com')` IS THE BUG THIS AVOIDS, and it is worth spelling out because it is
 * the shape everybody writes first: `evil-linkedin.com` ends with `linkedin.com`, and so does
 * `notlinkedin.com`. The host must be the domain itself or a subdomain of it, which means the
 * character before the suffix has to be a dot.
 *
 * Subdomains are accepted because LinkedIn serves the same profile from locale hosts —
 * `uk.linkedin.com/in/ada` and `www.linkedin.com/in/ada` are one person, and treating them as two
 * records would put the same human in the pipeline twice.
 */
export function isLinkedInHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === 'linkedin.com' || host.endsWith('.linkedin.com');
}

/**
 * The canonical form of a LinkedIn profile URL, or null.
 *
 * Canonical means: one string per human, whatever the caller pasted. LinkedIn hands out the same
 * profile as `https://uk.linkedin.com/in/Ada-Lovelace/?originalSubdomain=uk`,
 * `https://www.linkedin.com/in/ada-lovelace`, and
 * `https://www.linkedin.com/in/ada-lovelace/detail/recent-activity/`. All three are one record.
 *
 * So: the host collapses to `www.linkedin.com`, the query and fragment are dropped, anything
 * after the slug is dropped, and the slug is lower-cased — LinkedIn treats slugs
 * case-insensitively, and a canonical form that did not would let `/in/Ada` and `/in/ada` become
 * two people.
 *
 * The slug is NOT percent-decoded. Decoding then re-encoding is a normalisation of its own with
 * its own edge cases, and `decodeURIComponent` throws on a malformed sequence — which would turn
 * a bad input into an exception rather than a refusal. Percent-encoding is already
 * case-insensitive in its hex digits, so lower-casing is safe and sufficient.
 */
export function normaliseProfileUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let url: URL;
  try {
    // A bare `linkedin.com/in/ada` is what people paste out of a browser bar, so a scheme is
    // supplied when there is none rather than refusing on a technicality nobody intended.
    //
    // DETECTING *ANY* SCHEME, NOT JUST http(s). An earlier version tested `/^https?:\/\//` and
    // prepended otherwise — which made the protocol check below UNREACHABLE, because everything
    // arriving at it was http or https by construction. `file:///etc/passwd` became
    // `https://file` and was caught by the host check instead; the protocol guard read as
    // protective and could never fire. A mutation run found it by removing the guard and
    // observing that nothing changed.
    //
    // The scheme pattern excludes `.` deliberately, so `www.linkedin.com:443/in/ada` is read as
    // a host and port rather than as a scheme named `www.linkedin.com`.
    url = new URL(/^[a-z][a-z0-9+-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  // CREDENTIALS IN THE URL ARE REFUSED, matching `crawlTarget.ts`, which carries a
  // CREDENTIALS_IN_URL code for the same reason. `https://user:pass@www.linkedin.com/in/ada` has
  // a LinkedIn host and is not a link anybody should be storing; and a mangled scheme is how one
  // arrives by accident — `mailto:x@linkedin.com/in/ada` parses `mailto:x` as userinfo and
  // `linkedin.com` as the host, which is exactly the shape a mutation run surfaced here.
  if (url.username !== '' || url.password !== '') return null;

  if (!isLinkedInHost(url.hostname)) return null;

  const segments = url.pathname.split('/').filter((s) => s !== '');
  if (segments.length < 2) return null;
  if (segments[0].toLowerCase() !== 'in') return null;

  const slug = segments[1].toLowerCase();
  if (slug === '') return null;
  return `https://www.linkedin.com/in/${slug}`;
}

/** Whether a URL is a LinkedIn COMPANY page, which is an organisation and not a person. */
export function isCompanyProfileUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    const trimmed = raw.trim();
    url = new URL(/^[a-z][a-z0-9+-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (!isLinkedInHost(url.hostname)) return false;
  const first = url.pathname.split('/').filter((s) => s !== '')[0];
  return typeof first === 'string' && ['company', 'school', 'showcase'].includes(first.toLowerCase());
}

function limitFor(field: string): number {
  if (field === 'notes') return MAX_PROSPECT_NOTES;
  if (field === 'headline') return MAX_PROSPECT_HEADLINE;
  return MAX_PROSPECT_FIELD;
}

/**
 * Validate a proposed prospect.
 *
 * Mirrors `validateCandidate` deliberately — same allowlist discipline, same neutralisation on
 * the way in, same refusal-rather-than-truncation on an over-long value. A scraped headline of
 * `=HYPERLINK(...)` is exactly as much of a problem in this collection as in the other one.
 */
export function validateProspect(raw: Readonly<Record<string, unknown>>): ProspectOutcome {
  // Checked FIRST, before anything else is read. A caller with an address has taken the wrong
  // path, and every other refusal below would send them off fixing the wrong thing.
  if (normalizeEmailKey(raw.email) !== null) {
    return {
      ok: false,
      code: 'HAS_EMAIL',
      message:
        'This record has an email address, so it is a contact rather than a prospect. Prospects ' +
        'exist only for people we cannot yet email; send it to the contact import instead, or ' +
        'create the prospect and promote it.',
    };
  }

  const suppliedUrl = raw.profileUrl;
  if (typeof suppliedUrl !== 'string' || suppliedUrl.trim() === '') {
    return {
      ok: false,
      code: 'NO_PROFILE_URL',
      message: 'No LinkedIn profile URL, which is the identity of a prospect the way an address is the identity of a contact.',
    };
  }

  const profileUrl = normaliseProfileUrl(suppliedUrl);
  if (profileUrl === null) {
    if (isCompanyProfileUrl(suppliedUrl)) {
      return {
        ok: false,
        code: 'COMPANY_NOT_PERSON',
        message:
          `${JSON.stringify(suppliedUrl.trim())} is a LinkedIn company or school page, not a ` +
          `person. A prospect is somebody we might eventually write to; an organisation is not.`,
      };
    }
    let looksLikeAUrl = false;
    try {
      const t = suppliedUrl.trim();
      looksLikeAUrl = isLinkedInHost(new URL(/^[a-z][a-z0-9+-]*:/i.test(t) ? t : `https://${t}`).hostname);
    } catch {
      looksLikeAUrl = false;
    }
    return looksLikeAUrl
      ? {
          ok: false,
          code: 'NOT_A_PROFILE',
          message:
            `${JSON.stringify(suppliedUrl.trim())} is on LinkedIn but is not a member profile. ` +
            `A prospect needs a /in/ URL.`,
        }
      : {
          ok: false,
          code: /^[\s]*[a-z]+:\/\//i.test(suppliedUrl) || suppliedUrl.includes('.')
            ? 'NOT_LINKEDIN'
            : 'BAD_PROFILE_URL',
          message:
            `${JSON.stringify(suppliedUrl.trim())} is not a LinkedIn profile URL. Note that a ` +
            `host merely ENDING in "linkedin.com" is not LinkedIn — evil-linkedin.com is not a ` +
            `subdomain of it.`,
        };
  }

  const values: Record<string, string> = {};
  for (const field of PROSPECT_FIELDS) {
    if (field === 'profileUrl') continue;
    const supplied = raw[field];
    if (typeof supplied !== 'string') continue;
    const trimmed = supplied.trim();
    if (trimmed === '') continue;
    if (trimmed.length > limitFor(field)) {
      return {
        ok: false,
        code: 'FIELD_TOO_LONG',
        message:
          `${field} is ${trimmed.length} characters, above the limit for that field. Refused ` +
          `rather than truncated: half a value stored as if it were whole is worse than none.`,
      };
    }
    values[field] = neutralizeCsvValue(trimmed);
  }

  if (values.country !== undefined) {
    const country = normaliseCountry(values.country);
    if (country === null) {
      return {
        ok: false,
        code: 'BAD_COUNTRY',
        message:
          `country ${JSON.stringify(values.country)} is not an ISO-3166 alpha-2 code. A prospect ` +
          `whose jurisdiction is unreadable becomes a contact the outreach gate refuses for a ` +
          `reason nobody can act on.`,
      };
    }
    values.country = country;
  }

  // The canonical URL, not the supplied one. Neutralisation is not applied to it: it is the
  // identity key, it has already been through `normaliseProfileUrl`, and altering it here would
  // mean the stored value and the derived id disagreed about which person this is.
  values.profileUrl = profileUrl;

  return {
    ok: true,
    prospect: {
      profileUrl,
      prospectId: derivedProspectId(profileUrl),
      fields: Object.freeze({ ...values }),
    },
  };
}
