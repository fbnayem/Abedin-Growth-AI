import { evaluateLawfulBasis } from './lawfulBasis';
import { isFreeMailAddress } from '../lib/identity';

/**
 * LEAD QUALIFICATION, WITHOUT THE MIDDLE VALUE (§8, §14, §26).
 *
 * WHAT WAS WRONG
 * --------------
 * `ScoreBreakdown` declares five components summing to 100, and the generator that filled them
 * chose numbers from the loop index: `icpFit: Math.min(30, 24 + (i % 6))`. Every lead scored
 * between 79 and 89, with three paragraphs of reasons naming a city and a job title. It looked
 * like research. It was arithmetic on a counter.
 *
 * That generator is gone, and the interesting question is what replaces it, because the obvious
 * replacement is worse than nothing:
 *
 *     icpFit = industryMatches ? 30 : 15      // <- the defect, restated
 *
 * A LEAD WITH NO INDUSTRY RECORDED WOULD SCORE 15. A middle value for a missing input is
 * indistinguishable, downstream, from a measured one. The operator sorts by score, sees 62, and
 * has no way to tell whether that is "assessed as mediocre" or "we know almost nothing". The
 * second is the common case for a bought list, and it is the case where the number does the
 * most damage.
 *
 * THE RULE
 * --------
 * A COMPONENT WITH NO INPUT IS NOT SCORED. Its score is `null`, not zero and not a default. It
 * is removed from the denominator and named in `notScored`, so the caller is told both what was
 * measured and how much of the picture was measurable at all.
 *
 * This is why `LeadScore` carries two numbers that a single "score out of 100" would collapse:
 *
 *     score       how well it did on what could be assessed, 0-100
 *     confidence  how much of the rubric could be assessed at all, 0-100
 *
 * NEITHER IS ALLOWED TO TRAVEL ALONE. A caller that stores or displays the score without the
 * confidence has rebuilt the thing this module exists to remove, because 100-out-of-10-points
 * and 100-out-of-100-points render identically.
 *
 * A lead at score 90 / confidence 20 and one at score 90 / confidence 95 are not the same lead,
 * and no single number can say so. The console shows both; a caller that wants one number is
 * asked to decide for itself which of the two it means.
 *
 * ZERO IS A MEASUREMENT
 * ---------------------
 * Not every absent field means "unknown". A contact with no recorded engagement genuinely has
 * no intent signal, and that is a finding: it scores 0 for intent rather than going unscored.
 * The distinction each component makes is stated in its own comment, because getting it wrong
 * in either direction is a way to lie — treating unknown as zero punishes a new lead, and
 * treating a real zero as unknown flatters an unresponsive one.
 *
 * EVERY SCORE CARRIES ITS RUBRIC VERSION
 * --------------------------------------
 * A score computed under one rubric and read under another cannot be explained. The version is
 * stored with the score, and the components carry the sentence that produced them, so "why is
 * this 22?" has an answer six months later.
 */

/** Bumped whenever a component's rule changes. Stored with every score. */
export const RUBRIC_VERSION = 'lead-rubric-2026-09-15';

export const COMPONENT_KEYS = [
  'icpFit',
  'painProbability',
  'intent',
  'decisionMakerQuality',
  'contactability',
] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

/** The weights `ScoreBreakdown` has always declared. They sum to 100. */
export const COMPONENT_MAX: Readonly<Record<ComponentKey, number>> = Object.freeze({
  icpFit: 30,
  painProbability: 25,
  intent: 20,
  decisionMakerQuality: 15,
  contactability: 10,
});

export interface ScoredComponent {
  readonly key: ComponentKey;
  readonly max: number;
  /** Points earned, or null when there was nothing to assess. Never a default. */
  readonly score: number | null;
  /** The rule that produced the number, or what is missing. Shown to the operator verbatim. */
  readonly why: string;
}

export interface LeadScore {
  readonly rubricVersion: string;
  readonly components: readonly ScoredComponent[];
  /** Points earned across the components that could be assessed. */
  readonly earned: number;
  /** Points those components were worth. Never zero — see `confidence`. */
  readonly assessable: number;
  /**
   * How well it did on what could be assessed, 0-100.
   *
   * ALWAYS A NUMBER, AND NEVER MEANINGFUL ALONE. Contactability is the one component that can
   * always be assessed — suppression and a lawful basis are facts about the record rather than
   * about the world — so there is always at least one scored component and the arithmetic
   * always has a denominator. That is why this is not nullable: a null branch here would be
   * unreachable, and an unreachable branch is a claim nothing can check.
   *
   * What stops the number from lying is `confidence`, not nullability. 100 at confidence 10 and
   * 100 at confidence 100 are different findings, and any caller showing one must show both.
   */
  readonly score: number;
  /** How much of the rubric could be assessed at all, 0-100. */
  readonly confidence: number;
  readonly notScored: readonly ComponentKey[];
  /** Specific, checkable observations. Never prose about a city nobody looked up. */
  readonly signals: readonly string[];
  /** Reasons to be careful. Includes "we could not assess X", which is a risk. */
  readonly risks: readonly string[];
}

/** What a scorer reads from the company brain. Everything optional; absent means unscored. */
export interface IcpDefinition {
  readonly targetIndustries?: readonly string[];
  readonly targetCountries?: readonly string[];
  readonly targetPersonas?: readonly {
    readonly title?: string;
    readonly department?: string;
    /** The problem this persona has, which is what a note on a record is matched against. */
    readonly painPoint?: string;
  }[];
}

/** What a scorer reads from a contact. Everything is `unknown`: it arrives from a document. */
export interface ScorableContact {
  readonly email?: unknown;
  readonly title?: unknown;
  readonly industry?: unknown;
  readonly country?: unknown;
  readonly employeeCount?: unknown;
  readonly companyWebsite?: unknown;
  readonly companyName?: unknown;
  readonly timeZone?: unknown;
  readonly phone?: unknown;
  readonly notes?: unknown;
  readonly lawfulBasis?: unknown;
  readonly addressType?: unknown;
  readonly consentGiven?: unknown;
  readonly consentEvidence?: unknown;
  readonly consentRecordedBy?: unknown;
  readonly consentRevokedAt?: unknown;
  readonly liaId?: unknown;
  readonly article14NoticeSentAt?: unknown;
  readonly suppressed?: unknown;
  readonly unsubscribed?: unknown;
  readonly hardBounced?: unknown;
  readonly complained?: unknown;
  /** Engagement, where any has been recorded. */
  readonly openCount?: unknown;
  readonly clickedAt?: unknown;
  readonly repliedAt?: unknown;
  readonly emailStatus?: unknown;
  readonly lastActivityAt?: unknown;
  readonly contactedAt?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Do two industry or department strings refer to the same thing, allowing for phrasing? */
function overlaps(a: string, b: string): boolean {
  const left = normalise(a);
  const right = normalise(b);
  if (left === '' || right === '') return false;
  if (left === right) return true;
  // Word-level containment, so "Dental Practices" matches "dental" and "private dental clinic".
  const leftWords = new Set(left.split(' ').filter((w) => w.length > 3));
  const rightWords = right.split(' ').filter((w) => w.length > 3);
  return rightWords.some((w) => leftWords.has(w));
}

/**
 * Seniority from a job title.
 *
 * A LIST, NOT A MODEL. Every entry is a string somebody can read and argue with, which is the
 * property that matters: a title that scores 15 can be traced to the word that did it. An
 * opaque scorer would be the fabricated-research problem with extra steps.
 */
const SENIORITY: readonly { readonly points: number; readonly words: readonly string[]; readonly label: string }[] = [
  {
    points: 15,
    label: 'owner or board-level: signs without asking anyone',
    words: ['founder', 'owner', 'ceo', 'chief executive', 'managing director', 'proprietor', 'principal', 'partner'],
  },
  {
    points: 13,
    label: 'C-suite or director: holds a budget',
    words: ['cto', 'cfo', 'coo', 'cmo', 'chief', 'director', 'vp', 'vice president', 'head of'],
  },
  {
    points: 9,
    label: 'manager: influences a budget, rarely signs alone',
    words: ['manager', 'lead', 'supervisor', 'practice manager'],
  },
  {
    points: 4,
    label: 'individual contributor: a route in, not a decision',
    words: ['engineer', 'developer', 'analyst', 'coordinator', 'assistant', 'executive', 'associate', 'specialist', 'consultant', 'receptionist', 'nurse'],
  },
];

/**
 * ICP fit, 0-30.
 *
 * NOT SCORED when the company brain declares no targets at all — there is no rubric to measure
 * against, and inventing one would be the fabrication. Also not scored when the contact carries
 * neither an industry nor a country, because then there is nothing to compare.
 *
 * A contact that HAS an industry which does NOT match is scored, and scored low. That is a
 * measurement, not an absence.
 */
function scoreIcpFit(contact: ScorableContact, icp: IcpDefinition): ScoredComponent {
  const max = COMPONENT_MAX.icpFit;
  const industries = (icp.targetIndustries ?? []).filter((i) => text(i) !== null);
  const countries = (icp.targetCountries ?? []).filter((c) => text(c) !== null);

  if (industries.length === 0 && countries.length === 0) {
    return {
      key: 'icpFit',
      max,
      score: null,
      why:
        'Not scored: the company brain declares no target industries and no target countries, ' +
        'so there is no profile to measure this contact against.',
    };
  }

  const industry = text(contact.industry);
  const country = text(contact.country);
  if (industry === null && country === null) {
    return {
      key: 'icpFit',
      max,
      score: null,
      why: 'Not scored: this contact records neither an industry nor a country.',
    };
  }

  // 20 of the 30 points are the industry, 10 the country, and each half is only scored when
  // both sides of its comparison exist. A contact with a country and no industry is scored out
  // of the country half alone, and says so.
  let earned = 0;
  let possible = 0;
  const notes: string[] = [];

  if (industries.length > 0 && industry !== null) {
    possible += 20;
    const hit = industries.find((target) => overlaps(target, industry));
    if (hit !== undefined) {
      earned += 20;
      notes.push(`industry "${industry}" matches the target "${hit}"`);
    } else {
      notes.push(`industry "${industry}" is not among the ${industries.length} targets`);
    }
  }

  if (countries.length > 0 && country !== null) {
    possible += 10;
    const hit = countries.find((target) => overlaps(target, country) || target.toUpperCase() === country.toUpperCase());
    if (hit !== undefined) {
      earned += 10;
      notes.push(`country ${country} is a target market`);
    } else {
      notes.push(`country ${country} is not among the target markets`);
    }
  }

  if (possible === 0) {
    return {
      key: 'icpFit',
      max,
      score: null,
      why:
        'Not scored: the contact and the target profile have no field in common to compare — ' +
        'one states an industry where the other states only countries, or the reverse.',
    };
  }

  // Scaled to the full weight of the component, because what was compared IS the fit test that
  // could be run. The alternative — scoring 20 out of 30 for a perfect match on the only
  // available axis — would penalise the contact for a gap in the company brain.
  const score = Math.round((earned / possible) * max);
  return { key: 'icpFit', max, score, why: `${notes.join('; ')}.` };
}

/**
 * Pain probability, 0-25.
 *
 * ALMOST ALWAYS NOT SCORED, and that is the honest answer. Pain is evidence that this specific
 * company has the problem the product solves: a job advert, a review complaining about the
 * thing, a page on their site that says so. None of that is in a contact record, and none of it
 * arrives in a CSV.
 *
 * Scored only where a note or a persona pain point actually appears in the record, and the
 * score then reflects how much was found rather than how plausible it sounds. When the
 * scraping worker starts attaching evidence to a record, this is where it lands.
 */
function scorePainProbability(contact: ScorableContact, icp: IcpDefinition): ScoredComponent {
  const max = COMPONENT_MAX.painProbability;
  const notes = text(contact.notes);
  const painPoints = (icp.targetPersonas ?? [])
    .map((p) => text(p.painPoint))
    .filter((p): p is string => p !== null);

  if (notes === null) {
    return {
      key: 'painProbability',
      max,
      score: null,
      why:
        'Not scored: nothing on this record is evidence that this company has the problem. ' +
        'A guess here would be the number the deleted generator used to produce.',
    };
  }

  if (painPoints.length === 0) {
    return {
      key: 'painProbability',
      max,
      score: null,
      why:
        'Not scored: the record carries notes, but the company brain declares no persona pain ' +
        'points to match them against.',
    };
  }

  const matched = painPoints.filter((pain) => overlaps(pain, notes));
  if (matched.length === 0) {
    return {
      key: 'painProbability',
      max,
      score: 0,
      why: `Nothing in the recorded notes corresponds to any of the ${painPoints.length} declared pain points.`,
    };
  }

  // Half the weight for one corroborating note, full weight for two or more. A single line of
  // text is a hint, not a case.
  const score = matched.length >= 2 ? max : Math.round(max / 2);
  return {
    key: 'painProbability',
    max,
    score,
    why: `${matched.length} declared pain point(s) appear in the recorded notes: ${matched
      .map((m) => JSON.stringify(m.slice(0, 60)))
      .join(', ')}.`,
  };
}

/**
 * Intent, 0-20.
 *
 * ZERO IS A MEASUREMENT HERE, with one exception. A contact that has been emailed and has not
 * opened, clicked or replied has demonstrated no intent, and 0 is the finding. A contact that
 * has never been contacted has demonstrated nothing either way, and is NOT scored — scoring a
 * brand new lead 0 for intent would rank every fresh import below every stale one.
 */
function scoreIntent(contact: ScorableContact): ScoredComponent {
  const max = COMPONENT_MAX.intent;
  const contactedAt = text(contact.contactedAt);
  const opens = typeof contact.openCount === 'number' && Number.isFinite(contact.openCount)
    ? Math.max(0, Math.floor(contact.openCount))
    : 0;
  const clicked = text(contact.clickedAt) !== null;
  const replied = text(contact.repliedAt) !== null || contact.emailStatus === 'REPLIED';

  if (contactedAt === null && opens === 0 && !clicked && !replied) {
    return {
      key: 'intent',
      max,
      score: null,
      why:
        'Not scored: this contact has never been sent anything, so there has been no ' +
        'opportunity to show intent. Scoring it zero would rank every new lead below every ' +
        'unresponsive one.',
    };
  }

  if (replied) {
    return { key: 'intent', max, score: max, why: 'Replied, which is the strongest signal recorded.' };
  }
  if (clicked) {
    return { key: 'intent', max, score: 15, why: 'Clicked a link but has not replied.' };
  }
  if (opens >= 3) {
    return { key: 'intent', max, score: 10, why: `Opened ${opens} times without clicking.` };
  }
  if (opens > 0) {
    return { key: 'intent', max, score: 5, why: `Opened ${opens} time(s).` };
  }
  return {
    key: 'intent',
    max,
    score: 0,
    why: 'Contacted, with no open, click or reply recorded. That is a measurement, not a gap.',
  };
}

/**
 * Decision-maker quality, 0-15.
 *
 * NOT SCORED without a title. A seniority guess from a company size or an email prefix is the
 * kind of inference that reads as research and is not.
 */
function scoreDecisionMaker(contact: ScorableContact, icp: IcpDefinition): ScoredComponent {
  const max = COMPONENT_MAX.decisionMakerQuality;
  const title = text(contact.title);
  if (title === null) {
    return {
      key: 'decisionMakerQuality',
      max,
      score: null,
      why: 'Not scored: no job title is recorded, and seniority cannot be inferred from the rest.',
    };
  }

  const lower = ` ${normalise(title)} `;
  const band = SENIORITY.find((b) => b.words.some((w) => lower.includes(` ${normalise(w)} `)));

  // A title that matches a declared persona is worth the full weight whatever the band, because
  // the operator has said that is who they sell to.
  const persona = (icp.targetPersonas ?? []).find((p) => {
    const t = text(p.title);
    return t !== null && overlaps(t, title);
  });
  if (persona !== undefined) {
    return {
      key: 'decisionMakerQuality',
      max,
      score: max,
      why: `"${title}" matches the declared target persona "${text(persona.title)}".`,
    };
  }

  if (band === undefined) {
    return {
      key: 'decisionMakerQuality',
      max,
      score: null,
      why:
        `Not scored: "${title}" matches no seniority band in the rubric and no declared ` +
        `persona. An unrecognised title is unknown seniority, not middling seniority.`,
    };
  }

  return { key: 'decisionMakerQuality', max, score: band.points, why: `"${title}" — ${band.label}.` };
}

/**
 * Contactability, 0-10.
 *
 * ALWAYS SCORED, and it is the component the system knows most about — it is the one thing that
 * is genuinely a property of the record rather than of the world. Suppression, a lawful basis,
 * a usable address and a time zone are all present or absent as facts, so there is no unknown.
 */
function scoreContactability(contact: ScorableContact): ScoredComponent {
  const max = COMPONENT_MAX.contactability;
  const suppressed =
    contact.suppressed === true ||
    contact.unsubscribed === true ||
    contact.hardBounced === true ||
    contact.complained === true;

  if (suppressed) {
    return {
      key: 'contactability',
      max,
      score: 0,
      why: 'Suppressed: unsubscribed, bounced or complained. Nothing may be sent to this contact.',
    };
  }

  const verdict = evaluateLawfulBasis(contact);
  if (verdict.ok === false) {
    // Two points for having a usable address at all, which is what makes the record worth
    // keeping while the basis is sorted out. Not zero — that is reserved for suppression, which
    // is permanent in a way a missing notice is not.
    const usable = isFreeMailAddress(contact.email) !== null;
    return {
      key: 'contactability',
      max,
      score: usable ? 2 : 0,
      why: `Not currently mailable (${verdict.code}). ${verdict.message}`,
    };
  }

  let score = 7;
  const notes = [`Mailable on ${verdict.basis} under the ${verdict.regime} regime for ${verdict.country}.`];
  if (text(contact.timeZone) !== null) {
    score += 2;
    notes.push('time zone known, so quiet hours can be honoured');
  } else {
    notes.push('no time zone recorded, which the campaign engine refuses to guess');
  }
  if (text(contact.phone) !== null) {
    score += 1;
    notes.push('phone number on file as a second channel');
  }
  return { key: 'contactability', max, score: Math.min(max, score), why: notes.join('; ') + '.' };
}

/**
 * Score a contact against the declared ideal customer profile.
 *
 * Pure. No store, no clock, no model. Everything it knows comes from its two arguments, so a
 * score is reproducible from the record and the rubric version alone — which is what "explain
 * this score" requires six months later.
 */
export function scoreLead(contact: ScorableContact, icp: IcpDefinition = {}): LeadScore {
  const components: ScoredComponent[] = [
    scoreIcpFit(contact, icp),
    scorePainProbability(contact, icp),
    scoreIntent(contact),
    scoreDecisionMaker(contact, icp),
    scoreContactability(contact),
  ];

  const scored = components.filter((c) => c.score !== null);
  const earned = scored.reduce((sum, c) => sum + (c.score as number), 0);
  const assessable = scored.reduce((sum, c) => sum + c.max, 0);
  const total = components.reduce((sum, c) => sum + c.max, 0);
  const notScored = components.filter((c) => c.score === null).map((c) => c.key);

  const signals = scored
    .filter((c) => (c.score as number) > c.max / 2)
    .map((c) => `${c.key}: ${c.why}`);
  const risks = components
    .filter((c) => c.score === null || (c.score as number) <= c.max / 2)
    .map((c) => `${c.key}: ${c.why}`);

  return {
    rubricVersion: RUBRIC_VERSION,
    components,
    earned,
    assessable,
    score: Math.round((earned / assessable) * 100),
    confidence: Math.round((assessable / total) * 100),
    notScored,
    signals,
    risks,
  };
}
