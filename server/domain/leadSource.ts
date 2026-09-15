/**
 * WHERE A LEAD CAME FROM, AS A CLOSED VOCABULARY RATHER THAN AS PROSE (§14).
 *
 * WHAT WAS WRONG
 * --------------
 * A balancing assessment declares `dataSources` — "company website contact pages", "CSV from a
 * trade directory" — and a contact carries `source`, a string of the shape `MANUAL`, `IMPORT`,
 * `PROVIDER:<name>` or `SCRAPE:<host>`. Nothing compared them. `assessmentVerdict` checked that
 * the assessment covered the contact's COUNTRY and stopped there, so two assessments both
 * covering `GB` were interchangeable as far as the gate was concerned.
 *
 * That was theoretical while this system had one audience. It stopped being theoretical when a
 * second one arrived: a person identified on LinkedIn could cite the assessment written for
 * dental practices scraped from their own websites, and nothing would object.
 *
 * WHY THE PROSE FIELD COULD NOT BE THE CHECK
 * ------------------------------------------
 * The obvious fix is to match the contact's `source` against the assessment's `dataSources`.
 * It does not work, and it is worth saying why, because the version that does not work is the
 * one that looks like more effort and therefore like more rigour.
 *
 * `dataSources` is written for a human reader and for a regulator. "Publicly listed contact
 * addresses on practice websites" is a good entry in it and shares no substring with
 * `SCRAPE:smilecare.example`. Any matcher bridging those two is a heuristic, and a heuristic in
 * a lawful-basis gate fails in both directions: it passes what it should refuse when a word
 * happens to coincide, and refuses what it should pass when the wording is merely different.
 * Worse, it READS like a check, which is the specific defect this repository keeps removing.
 *
 * So the assessment gains a second, machine-checkable field — `sourceKinds`, drawn from the
 * closed list below — and keeps `dataSources` for the prose. The prose is what a regulator
 * reads; the vocabulary is what the gate enforces. Neither pretends to be the other.
 *
 * WHY THE SOURCE CHANGES THE BALANCING TEST AT ALL
 * ------------------------------------------------
 * This is the substance of it, and it is the reason a single assessment cannot cover every
 * route. The balancing limb weighs what the person REASONABLY EXPECTED when the data was
 * published or handed over, and that expectation is a property of the route, not of the country:
 *
 *   SCRAPE    They published a contact address on their own site, for the purpose of being
 *             contacted about business. The expectation of business contact is about as strong
 *             as it gets, and the necessity limb is easy: the address is the point of the page.
 *   LINKEDIN  They published a PROFILE for professional networking. They did not publish an
 *             address. Somebody had to find one elsewhere, so there is an extra hop the person
 *             never participated in, and the expectation that a profile leads to cold email is
 *             materially weaker than the expectation attaching to a published address.
 *   PROVIDER  A third party asserts the person's details. Their expectation depends on what
 *             they were told by whoever collected it, which is a chain this system did not see.
 *   IMPORT    The same, minus even a named provider to ask.
 *   MANUAL    A person recorded it and recorded why, which is the best evidence of the lot and
 *             also the least uniform.
 *
 * Those are five different arguments. An assessment that made one of them does not support the
 * other four, and the honest thing for the gate to do is say so.
 *
 * WHY NEW SHAPES REFUSE
 * ---------------------
 * `classifyLeadSource` returns null for anything not in the list, and a null classification is a
 * refusal upstream, never a pass (§14). The cost is that adding a sixth ingest route means
 * adding a sixth kind here and re-signing the assessments that should cover it. That cost IS the
 * control: a new way of obtaining strangers' addresses should not inherit the justification
 * written for an older one just because nobody thought about it.
 */

/**
 * Every route by which a contact can enter this system.
 *
 * `leadSource.invariant.test.ts` scans the ingest services for the `source` values they actually
 * write and asserts each one classifies, so this list cannot quietly drift out of step with the
 * code that produces the strings.
 */
export const LEAD_SOURCE_KINDS = ['MANUAL', 'IMPORT', 'PROVIDER', 'SCRAPE', 'LINKEDIN'] as const;
export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[number];

/**
 * Kinds whose source string is `KIND:<particular>`, where the particular is load-bearing.
 *
 * `SCRAPE` without a host, or `PROVIDER` without a name, does not say where the data came from,
 * and "where it came from" is the whole content of the Article 14 notice. A bare prefix is
 * therefore unclassifiable rather than a generic member of its kind.
 */
export const QUALIFIED_SOURCE_KINDS: readonly LeadSourceKind[] = ['PROVIDER', 'SCRAPE'];

/** Kinds that stand alone. A particular after a colon on one of these is an unrecognised shape. */
export const BARE_SOURCE_KINDS: readonly LeadSourceKind[] = ['MANUAL', 'IMPORT', 'LINKEDIN'];

/**
 * What each kind means, in the words a person signing an assessment would need.
 *
 * Kept here rather than in the UI because the refusal messages quote it, and a refusal that
 * explains itself in the same terms as the form that fixes it is one an operator can act on.
 */
export const LEAD_SOURCE_KIND_NOTES: Readonly<Record<LeadSourceKind, string>> = {
  MANUAL: 'entered by a member of staff, who recorded where they got it',
  IMPORT: 'read from a list or file uploaded into this system',
  PROVIDER: 'returned by a third-party data provider in answer to a search',
  SCRAPE: 'collected from a publicly accessible page on the organisation’s own website',
  LINKEDIN: 'identified from a LinkedIn profile, with the address found separately',
};

const QUALIFIED = new Set<string>(QUALIFIED_SOURCE_KINDS);
const BARE = new Set<string>(BARE_SOURCE_KINDS);

/**
 * Which kind of route produced this `source` string, or null if nothing recognises it.
 *
 * Null is the answer for an empty string, an unknown word, a bare `SCRAPE:`, and a `MANUAL:x`
 * that has been given a particular it does not take. Every one of those is a source this system
 * cannot reason about, and the caller's obligation is to refuse rather than to pick a default —
 * a default here would be a sixth ingest route silently inheriting a fifth route's signature.
 */
export function classifyLeadSource(source: unknown): LeadSourceKind | null {
  const raw = typeof source === 'string' ? source.trim() : '';
  if (raw === '') return null;

  const colon = raw.indexOf(':');
  if (colon === -1) {
    const word = raw.toUpperCase();
    return BARE.has(word) ? (word as LeadSourceKind) : null;
  }

  const head = raw.slice(0, colon).trim().toUpperCase();
  const particular = raw.slice(colon + 1).trim();
  if (particular === '') return null;
  return QUALIFIED.has(head) ? (head as LeadSourceKind) : null;
}

/** The part after the colon — the host, the provider name — or null when there is none. */
export function sourceParticular(source: unknown): string | null {
  const raw = typeof source === 'string' ? source.trim() : '';
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const particular = raw.slice(colon + 1).trim();
  return particular === '' ? null : particular;
}

/** Is this one of the kinds? Used to validate what an assessment claims to cover. */
export function isLeadSourceKind(value: unknown): value is LeadSourceKind {
  return typeof value === 'string' && (LEAD_SOURCE_KINDS as readonly string[]).includes(value);
}

/** The kinds an assessment declares, normalised and de-duplicated, or null if any is unknown. */
export function normaliseSourceKinds(values: unknown): readonly LeadSourceKind[] | null {
  if (!Array.isArray(values)) return null;
  const out: LeadSourceKind[] = [];
  for (const value of values) {
    const word = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!isLeadSourceKind(word)) return null;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}
