/**
 * WHERE THE EMAIL ADDRESS CAME FROM, WHICH IS NOT WHERE THE PERSON CAME FROM (§14).
 *
 * WHAT WAS WRONG
 * --------------
 * `./leadSource` closed the route gap: a contact's `source` became a closed vocabulary and
 * `assessmentVerdict` checks it. That answers how the PERSON was identified. It does not answer
 * how the ADDRESS was obtained, and those are different facts about different acts.
 *
 * `lia-linkedin-2026.md` says so in its own words, and names this as the gap to close before LP4:
 *
 *     "`sourceKinds` records how the person was identified. `emailSource` records how the
 *      address was obtained — and it is free text, so nothing checks it."
 *
 * The consequence was reachable, and the proof was sitting in the test suite. A prospect promoted
 * with `emailSource: 'enrichment provider acme-data'` produced a contact whose `source` is
 * `LINKEDIN`, covered by the LinkedIn assessment as far as the gate could tell — while that
 * document's necessity limb says in as many words that it does NOT cover a purchased address.
 *
 * WHY THE PROSE FIELD COULD NOT BE THE CHECK
 * ------------------------------------------
 * The same argument as `./leadSource`, one level down, and it is worth repeating because the
 * version that does not work is the one that looks like more effort. `emailSource` is written for
 * a human: "enrichment provider acme-data", "found on their contact page", "guessed from the
 * firstname@ convention". Matching that against a closed set is a heuristic, and a heuristic in a
 * lawful-basis gate fails in both directions while reading like a check.
 *
 * So the assessment gains a second machine-checkable list and the prose stays prose.
 *
 * WHY THE ADDRESS SOURCE CHANGES THE BALANCING TEST AT ALL
 * -------------------------------------------------------
 * Because the person's reasonable expectation attaches to the act of publication, and these are
 * six different acts:
 *
 *   SUBJECT_SUPPLIED   They gave it to us. The strongest expectation there is — and the one case
 *                      where Article 14 is arguably the wrong notice entirely, because the datum
 *                      did not come from a third party. See the note on the notice below.
 *   EMPLOYER_WEBSITE   Their employer published it, on their own site, to be contacted on. The
 *                      necessity limb is nearly trivial: the address is the point of the page.
 *   PUBLIC_DIRECTORY   Published in a register or directory — often for a STATUTORY purpose that
 *                      has nothing to do with marketing. A Companies House address is published
 *                      because the law compels it, not because anyone wants email. Materially
 *                      weaker than EMPLOYER_WEBSITE, and easy to conflate with it.
 *   PROVIDER           A third party asserts it, through a collection chain we did not see and a
 *                      notice obligation somebody else discharged or did not.
 *   INFERRED_PATTERN   It was never published AT ALL. We constructed it from the employer's naming
 *                      convention. This carries an accuracy risk no other kind carries: a guessed
 *                      address can belong to a different person of the same name, so the notice
 *                      itself can go to the wrong human.
 *   MANUAL_RESEARCH    A person found it somewhere none of the above names, and wrote down where.
 *                      The best evidence of the lot and the least uniform.
 *
 * Six arguments. An assessment that made one of them is not evidence about the other five.
 *
 * WHY PROVIDER IS BLOCKED AND INFERRED_PATTERN IS NOT
 * --------------------------------------------------
 * Blocking `PROVIDER` here is not tidiness; without it the policy in `./leadSource` is
 * circumvented in one step. Identify the person on LinkedIn (permitted), buy their address
 * (invisible), send. That sequence IS the defect, and blocking the person-route alone does not
 * stop it.
 *
 * `INFERRED_PATTERN` is deliberately NOT blocked, and the asymmetry is the point. It is the route
 * `lia-linkedin-2026.md` was actually written about — blocking it would make the one drafted
 * assessment unable to declare the one route it covers, kill the second audience on arrival, and
 * put the pressure on editing this file to get moving. `lawfulBasis.ts` makes that argument at
 * length about `requireReviewedRegime`: a control people are motivated to defeat is worse than one
 * placed where the motivation runs the other way. The accuracy risk belongs in the signer's hands,
 * stated in the note below, not in a block that decides a balancing question for them.
 *
 * WHY THERE IS NO QUALIFIED FORM
 * ------------------------------
 * `./leadSource` has `SCRAPE:<host>` and `PROVIDER:<name>` because the particular is load-bearing
 * there. Here it is not: the particular — which provider, which directory, which page — belongs in
 * `addressSourceEvidence`, which is REQUIRED on every record. Accepting `PROVIDER:acme` would
 * create a second place for a provider's name to hide, which is the hole this module closes.
 *
 * It needs no guard. No member of the vocabulary contains a colon, so a qualified string fails the
 * membership test by itself — see the note in `classifyAddressSource`, which records a mutant
 * proving an earlier explicit check could never fire.
 */

/** Every route by which an email address can reach this system. */
export const ADDRESS_SOURCE_KINDS = [
  'SUBJECT_SUPPLIED',
  'EMPLOYER_WEBSITE',
  'PUBLIC_DIRECTORY',
  'PROVIDER',
  'INFERRED_PATTERN',
  'MANUAL_RESEARCH',
] as const;
export type AddressSourceKind = (typeof ADDRESS_SOURCE_KINDS)[number];

/**
 * What each route means, in the words a person signing an assessment needs.
 *
 * The refusal messages quote these, so a refusal explains itself in the same terms as the document
 * that would fix it.
 */
export const ADDRESS_SOURCE_KIND_NOTES: Readonly<Record<AddressSourceKind, string>> = {
  SUBJECT_SUPPLIED: 'the person gave us the address themselves',
  EMPLOYER_WEBSITE: 'published by their employer on the employer’s own website',
  PUBLIC_DIRECTORY:
    'published in a register or trade directory, possibly for a statutory purpose unrelated to marketing',
  PROVIDER: 'supplied by a third-party data provider',
  INFERRED_PATTERN:
    'never published — constructed from the employer’s naming convention, so it may reach a different person of the same name',
  MANUAL_RESEARCH: 'found by a person somewhere none of the other routes names, who recorded where',
};

/**
 * ROUTES NO ASSESSMENT MAY COVER, BY DECISION RATHER THAN BY OMISSION.
 *
 * The same mechanism as `UNCOVERABLE_SOURCE_KINDS` in `./leadSource`, and the same argument: the
 * route stays in the vocabulary so a contact carrying it is refused BY NAME with a sentence that
 * explains itself, rather than refused as an unrecognised shape that reads like a data error.
 *
 * TO REVERSE: empty this list and write the business case in the commit. Nothing else changes.
 */
export const UNCOVERABLE_ADDRESS_SOURCE_KINDS: Readonly<Record<string, string>> = {
  PROVIDER:
    'Purchased and third-party-supplied addresses are not used in the initial release, matching ' +
    'the same decision about purchased PERSON data in server/domain/leadSource.ts. Blocking only ' +
    'the person route would leave the policy circumventable in one step: identify the person on ' +
    'LinkedIn, buy the address, send. Reverse this in server/domain/addressSource.ts when there ' +
    'is a business case and evidence for the route, not because the vocabulary has a word for it.',
};

/** Is this route one no assessment may declare? Returns the recorded reason, or null. */
export function uncoverableAddressReason(kind: unknown): string | null {
  const word = typeof kind === 'string' ? kind.trim().toUpperCase() : '';
  return UNCOVERABLE_ADDRESS_SOURCE_KINDS[word] ?? null;
}

/** Is this one of the routes? Used to validate what an assessment claims to cover. */
export function isAddressSourceKind(value: unknown): value is AddressSourceKind {
  return typeof value === 'string' && (ADDRESS_SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * Which route produced this address, or null if nothing recognises it.
 *
 * Null for an empty string, an unknown word, and anything carrying a colon. Every one of those is
 * a provenance this system cannot reason about, and the caller's obligation is to refuse rather
 * than to pick a default — a default here would be a seventh route silently inheriting a sixth
 * route's signature.
 */
export function classifyAddressSource(value: unknown): AddressSourceKind | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return null;
  const word = raw.toUpperCase();
  // No qualified form, and NO GUARD FOR IT — the property holds by construction. Not one member
  // of the vocabulary contains a colon, so `PROVIDER:acme` fails the membership test on its own.
  //
  // A draft of this function carried `if (raw.includes(':')) return null;` above this line. A
  // mutant deleting it changed no output for any input, which is the signature of a guard that
  // reads as protective and cannot fire — the same defect LP1's mutation run found in
  // `normaliseProfileUrl`. There the fix was to make the guard REACHABLE, because the property it
  // asserted was not otherwise guaranteed. Here it is, so the fix is to delete it. The tests that
  // pin the behaviour stay: the BEHAVIOUR is the contract, and it must keep holding if the
  // vocabulary ever changes.
  return isAddressSourceKind(word) ? word : null;
}

/** The routes an assessment declares, normalised and de-duplicated, or null if any is unknown. */
export function normaliseAddressSourceKinds(values: unknown): readonly AddressSourceKind[] | null {
  if (!Array.isArray(values)) return null;
  const out: AddressSourceKind[] = [];
  for (const value of values) {
    const word = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!isAddressSourceKind(word)) return null;
    if (!out.includes(word)) out.push(word);
  }
  return out;
}
