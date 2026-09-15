/**
 * THE LEGITIMATE INTERESTS ASSESSMENT, AS A RECORD RATHER THAN AS A STRING (§14).
 *
 * WHAT WAS WRONG
 * --------------
 * `evaluateLawfulBasis` required `liaId` to be a non-empty string, and that was the whole check.
 * Typing `x` into the field satisfied it. The gate's own comment said "the assessment is what
 * makes the basis defensible", and the thing it actually verified was that somebody had typed
 * something — which is the shape of defect this repository keeps removing: a control that reads
 * as a check and is a formality.
 *
 * An assessment is now a document. It has the three parts the balancing test actually has, it
 * names the countries and data categories it covers, it is signed by a named person on a date,
 * and it expires. `liaId` must resolve to one of those, and the resolution happens before the
 * send rather than being assumed by it.
 *
 * THE THREE-PART TEST, AND WHY EACH PART IS A SEPARATE FIELD
 * ---------------------------------------------------------
 * The assessment that supports Article 6(1)(f) has a settled structure, and collapsing it into
 * one free-text box is how it gets written as a paragraph of marketing copy:
 *
 *   PURPOSE      What is the interest being pursued, and whose? An interest that cannot be
 *                stated in a sentence is usually not legitimate; it is usually "we want to sell
 *                things", which is a legitimate interest but has to be said out loud.
 *   NECESSITY    Why is processing THIS personal data needed to pursue it? If a less intrusive
 *                route reaches the same end, the necessity limb fails.
 *   BALANCING    Against the person's interests, rights and freedoms. This is the limb that
 *                actually decides it and the one most often written as an assertion.
 *
 * Each is stored separately and each has a floor on its length. A floor is a crude proxy for
 * substance and it is not nothing: it stops "n/a", "done", and an empty string that a `?? ''`
 * somewhere upstream turned into a pass.
 *
 * WHY A SIGNED ASSESSMENT IS IMMUTABLE
 * ------------------------------------
 * A signature is a claim about a specific text. If the text can change afterwards, the signature
 * attaches to nothing in particular and the record is worse than useless — it is misleading
 * evidence. So `sign` freezes the substantive fields, and changing them means withdrawing and
 * writing a new assessment, which is exactly the real-world act it models.
 *
 * WHY IT EXPIRES
 * --------------
 * The balancing test weighs a person's reasonable expectations, and those move. An assessment
 * with no review date is one nobody will ever revisit. Twelve months is the common practice and
 * is a default, not a rule: `reviewDueAt` is set explicitly at signing and this module only
 * supplies the default when the signer does not.
 */

import { OUTREACH_REGIMES } from './lawfulBasisSources';
import {
  LEAD_SOURCE_KINDS,
  LEAD_SOURCE_KIND_NOTES,
  classifyLeadSource,
  normaliseSourceKinds,
  type LeadSourceKind,
} from './leadSource';

/** How long a signature stands before somebody has to look at the assessment again. */
export const LIA_DEFAULT_REVIEW_MONTHS = 12;

/**
 * The floor on each limb of the three-part test.
 *
 * Crude on purpose. It cannot tell a considered paragraph from a padded one, and it is not
 * trying to: it exists so that "n/a" and "" cannot be the documented basis on which strangers
 * are emailed. Substance is the signer's job, and the signature is where that responsibility
 * is recorded.
 */
export const LIA_MIN_LIMB_CHARS = 120;

/** Upper bounds, so a stored assessment cannot become an unbounded write. */
export const LIA_MAX_LIMB_CHARS = 20_000;
export const LIA_MAX_LIST_ITEMS = 50;
export const LIA_MAX_ITEM_CHARS = 300;

/** The fields a signature freezes. Changing any of them after signing needs a new assessment. */
export const LIA_SUBSTANTIVE_FIELDS = [
  'title',
  'purpose',
  'necessity',
  'balancing',
  'countries',
  'sourceKinds',
  'dataCategories',
  'dataSources',
  'safeguards',
  'objectionRoute',
] as const;

export interface LiaDraft {
  /** A name a person would use for it: "UK B2B dental practices, Q3 2026". */
  readonly title: string;
  /** Limb one: the interest being pursued, and whose. */
  readonly purpose: string;
  /** Limb two: why processing this data is necessary to pursue it. */
  readonly necessity: string;
  /** Limb three: the balance against the data subject's interests, rights and freedoms. */
  readonly balancing: string;
  /** ISO-3166 alpha-2 codes this assessment covers. Must be in the outreach regime table. */
  readonly countries: readonly string[];
  /**
   * Which ROUTES of acquisition this assessment covers, from the closed list in `./leadSource`.
   *
   * The machine-checkable half of the same question `dataSources` answers in prose. The gate
   * compares a contact's `source` against this; a regulator reads `dataSources`. Separating them
   * is deliberate — see the header of `./leadSource` for why matching the prose would be a
   * heuristic dressed as a control.
   */
  readonly sourceKinds: readonly LeadSourceKind[];
  /** What categories of personal data are processed: "name", "work email", "job title". */
  readonly dataCategories: readonly string[];
  /** Where the data comes from, in prose: "company website contact pages", "a trade directory". */
  readonly dataSources: readonly string[];
  /** What reduces the impact: suppression on first objection, no personal addresses, and so on. */
  readonly safeguards: readonly string[];
  /** How a person objects, in terms they could act on. */
  readonly objectionRoute: string;
}

export interface LiaRecord extends LiaDraft {
  readonly id: string;
  readonly organizationId: string;
  readonly createdAt: string;
  readonly createdBy: string;
  /** Set when an UNSIGNED draft was edited. A signed one cannot be, so these stay null on it. */
  readonly amendedAt?: string | null;
  readonly amendedBy?: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  /** When the signature stops standing. Null while unsigned. */
  readonly reviewDueAt: string | null;
  readonly withdrawnAt: string | null;
  readonly withdrawnBy: string | null;
  readonly withdrawnReason: string | null;
  readonly version: number;
}

export type LiaRefusalCode =
  | 'LIA_NOT_FOUND'
  | 'LIA_UNSIGNED'
  | 'LIA_WITHDRAWN'
  | 'LIA_EXPIRED'
  | 'LIA_COUNTRY_NOT_COVERED'
  | 'LIA_SOURCE_UNKNOWN'
  | 'LIA_SOURCE_NOT_COVERED'
  | 'LIA_MALFORMED';

/**
 * The answer to "is this document in force", with no contact involved.
 *
 * Carries the record on success, so the caller that goes on to ask a coverage question is
 * narrowed to a non-null record without asserting it a second time — and so nothing has to
 * re-derive from the raw record what this function has already read out of it.
 */
export type LivenessVerdict =
  | {
      readonly ok: true;
      readonly record: LiaRecord;
      /**
       * The declared routes, normalised, non-empty, every entry known.
       *
       * Carried rather than re-derived so the coverage check has no `?? []` fallback to write \u2014
       * a fallback that, after the checks below, could never be taken. Unreachable defensive
       * code is the defect this repository keeps finding, and the way not to write it is to make
       * the guarantee available instead of re-asserting it.
       */
      readonly sourceKinds: readonly LeadSourceKind[];
      readonly id: string;
      readonly title: string;
      readonly signedBy: string;
      readonly signedAt: string;
      readonly reviewDueAt: string | null;
    }
  | { readonly ok: false; readonly code: LiaRefusalCode; readonly message: string };

export type AssessmentVerdict =
  | {
      readonly ok: true;
      readonly id: string;
      readonly title: string;
      readonly signedBy: string;
      readonly signedAt: string;
      readonly reviewDueAt: string | null;
      /**
       * The route this verdict was reached for — not every route the assessment covers.
       *
       * A verdict answers a question about one contact, so it reports the kind that contact's
       * `source` classified to. The Article 14 notice quotes it, and a notice that told someone
       * "we cover websites, directories and LinkedIn" rather than which one applies to them
       * would be answering a question they did not ask.
       */
      readonly sourceKind: LeadSourceKind;
    }
  | { readonly ok: false; readonly code: LiaRefusalCode; readonly message: string };

export type DraftRefusalCode =
  | 'LIA_LIMB_TOO_SHORT'
  | 'LIA_LIMB_TOO_LONG'
  | 'LIA_NO_COUNTRIES'
  | 'LIA_COUNTRY_UNKNOWN'
  | 'LIA_NO_SOURCE_KINDS'
  | 'LIA_SOURCE_KIND_UNKNOWN'
  | 'LIA_LIST_EMPTY'
  | 'LIA_LIST_TOO_LONG'
  | 'LIA_ITEM_TOO_LONG';

export type DraftOutcome =
  | { readonly ok: true; readonly draft: LiaDraft }
  | { readonly ok: false; readonly code: DraftRefusalCode; readonly message: string };

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => text(v)).filter((v) => v !== '');
}

/** The three limbs, plus the title and the objection route, which have their own floors. */
const LIMBS: readonly { field: keyof LiaDraft; label: string; min: number }[] = [
  { field: 'title', label: 'title', min: 8 },
  { field: 'purpose', label: 'the purpose test', min: LIA_MIN_LIMB_CHARS },
  { field: 'necessity', label: 'the necessity test', min: LIA_MIN_LIMB_CHARS },
  { field: 'balancing', label: 'the balancing test', min: LIA_MIN_LIMB_CHARS },
  { field: 'objectionRoute', label: 'the objection route', min: 20 },
];

const LISTS: readonly { field: keyof LiaDraft; label: string }[] = [
  { field: 'dataCategories', label: 'dataCategories' },
  { field: 'dataSources', label: 'dataSources' },
  { field: 'safeguards', label: 'safeguards' },
];

/**
 * Validate a proposed assessment.
 *
 * Every value is read off an `unknown` record, because this arrives from an HTTP body. Nothing
 * outside `LiaDraft` is carried through: the returned draft is rebuilt field by field, so a
 * caller cannot smuggle `signedBy` in with the prose.
 */
export function validateLiaDraft(raw: Readonly<Record<string, unknown>>): DraftOutcome {
  for (const { field, label, min } of LIMBS) {
    const value = text(raw[field]);
    if (value.length < min) {
      return {
        ok: false,
        code: 'LIA_LIMB_TOO_SHORT',
        message:
          `${label} is ${value.length} characters, below the ${min} this system requires. The ` +
          `floor is a crude proxy for substance and it is deliberate: an assessment is what ` +
          `makes legitimate interest defensible, and "n/a" cannot be that.`,
      };
    }
    if (value.length > LIA_MAX_LIMB_CHARS) {
      return {
        ok: false,
        code: 'LIA_LIMB_TOO_LONG',
        message: `${label} is ${value.length} characters, above the ${LIA_MAX_LIMB_CHARS} limit.`,
      };
    }
  }

  const countries = list(raw.countries).map((c) => c.toUpperCase());
  if (countries.length === 0) {
    return {
      ok: false,
      code: 'LIA_NO_COUNTRIES',
      message:
        'An assessment must say which jurisdictions it covers. The balancing test is not the ' +
        'same in every country, so an assessment that covers "everywhere" covers nothing.',
    };
  }
  if (countries.length > LIA_MAX_LIST_ITEMS) {
    return {
      ok: false,
      code: 'LIA_LIST_TOO_LONG',
      message: `countries has ${countries.length} entries, above the ${LIA_MAX_LIST_ITEMS} limit.`,
    };
  }
  for (const code of countries) {
    if (!OUTREACH_REGIMES[code]) {
      return {
        ok: false,
        code: 'LIA_COUNTRY_UNKNOWN',
        message:
          `${JSON.stringify(code)} is not in the outreach regime table, so nothing in this ` +
          `system can send there and an assessment covering it would be covering a case that ` +
          `cannot arise. Add the country with its citations first.`,
      };
    }
  }

  // The routes of acquisition, as a closed vocabulary rather than as prose. An assessment that
  // names none covers no route, which — since every contact arrives by some route — means it
  // supports no send at all. Refusing at authoring time says that plainly, rather than leaving
  // the author to discover it later as a refusal on every contact they try.
  // Absent and wrong are different facts with different remedies, so they are different codes.
  // An author who left the field out needs to be told it exists; one who typed `APOLLO` needs the
  // list of what is accepted. Folding them together reported a missing field as containing an
  // unrecognised route named "undefined", which sends the author looking for a typo.
  const sourceKinds =
    raw.sourceKinds === undefined ? [] : normaliseSourceKinds(raw.sourceKinds);
  if (sourceKinds === null) {
    return {
      ok: false,
      code: 'LIA_SOURCE_KIND_UNKNOWN',
      message:
        `sourceKinds contains a route this system does not recognise ` +
        `(${JSON.stringify(raw.sourceKinds)}). The recognised routes are ` +
        `${LEAD_SOURCE_KINDS.map((k) => `${k} (${LEAD_SOURCE_KIND_NOTES[k]})`).join('; ')}.`,
    };
  }
  if (sourceKinds.length === 0) {
    return {
      ok: false,
      code: 'LIA_NO_SOURCE_KINDS',
      message:
        'An assessment must say which routes of acquisition it covers. The balancing test turns ' +
        'on what the person reasonably expected when they published or handed over their ' +
        'details, and that expectation is a property of the route: an address published on a ' +
        'company contact page and a profile found on LinkedIn are two different arguments. ' +
        'An assessment covering "however we got it" covers nothing.',
    };
  }

  const lists: Record<string, string[]> = {};
  for (const { field, label } of LISTS) {
    const values = list(raw[field]);
    if (values.length === 0) {
      return {
        ok: false,
        code: 'LIA_LIST_EMPTY',
        message:
          `${label} is empty. Each of dataCategories, dataSources and safeguards is an input ` +
          `to the balancing test, and an empty one means the test was not performed on it.`,
      };
    }
    if (values.length > LIA_MAX_LIST_ITEMS) {
      return {
        ok: false,
        code: 'LIA_LIST_TOO_LONG',
        message: `${label} has ${values.length} entries, above the ${LIA_MAX_LIST_ITEMS} limit.`,
      };
    }
    for (const item of values) {
      if (item.length > LIA_MAX_ITEM_CHARS) {
        return {
          ok: false,
          code: 'LIA_ITEM_TOO_LONG',
          message: `An entry in ${label} is ${item.length} characters, above ${LIA_MAX_ITEM_CHARS}.`,
        };
      }
    }
    lists[field] = values;
  }

  return {
    ok: true,
    draft: {
      title: text(raw.title),
      purpose: text(raw.purpose),
      necessity: text(raw.necessity),
      balancing: text(raw.balancing),
      countries: Object.freeze([...new Set(countries)]),
      sourceKinds: Object.freeze(sourceKinds),
      dataCategories: Object.freeze(lists.dataCategories),
      dataSources: Object.freeze(lists.dataSources),
      safeguards: Object.freeze(lists.safeguards),
      objectionRoute: text(raw.objectionRoute),
    },
  };
}

/** The default review date for a signature taken at `signedAt`. */
export function defaultReviewDue(signedAt: Date): string {
  const due = new Date(signedAt.getTime());
  due.setUTCMonth(due.getUTCMonth() + LIA_DEFAULT_REVIEW_MONTHS);
  return due.toISOString();
}

/**
 * IS THIS DOCUMENT LIVE? Signed, unwithdrawn, in date, and not garbled.
 *
 * Separated from coverage because it is a genuinely different question and has genuinely
 * different callers. The console lists assessments and the preflight counts them; neither has a
 * contact in hand, and neither should have to invent one to ask whether a document is in force.
 *
 * AN EARLIER VERSION OF THIS FUNCTION GOT THAT WRONG IN AN INSTRUCTIVE WAY. It called
 * `assessmentVerdict` and probed coverage with the assessment\u2019s own first country and first
 * declared route \u2014 which looked circular-but-harmless and was not, because a declared route is a
 * KIND (`SCRAPE`) and a contact\u2019s provenance is a SOURCE STRING (`SCRAPE:smilecare.example`).
 * Two different things wearing the same primitive type. The probe never classified, so every
 * live assessment reported as unusable. Splitting the questions removes the need to fabricate an
 * input at all, which is the fix rather than a better fake.
 *
 * Returns the record on success so the caller that needs coverage next is narrowed to a
 * non-null record without asserting it a second time.
 */
export function livenessVerdict(record: LiaRecord | null, now: Date): LivenessVerdict {
  if (record === null) {
    return {
      ok: false,
      code: 'LIA_NOT_FOUND',
      message:
        'The contact references a balancing assessment that does not exist in this ' +
        'organisation. A reference to a missing document is not a document.',
    };
  }

  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return {
      ok: false,
      code: 'LIA_MALFORMED',
      message: 'The stored assessment has no id, so it cannot be cited as evidence of anything.',
    };
  }

  if (text(record.withdrawnAt) !== '') {
    return {
      ok: false,
      code: 'LIA_WITHDRAWN',
      message:
        `Assessment ${record.id} was withdrawn at ${record.withdrawnAt}` +
        `${text(record.withdrawnReason) === '' ? '' : `: ${record.withdrawnReason}`}. ` +
        `A withdrawn assessment does not support outreach, and re-signing it is not the remedy ` +
        `\u2014 write the assessment that replaces it.`,
    };
  }

  const signedAt = text(record.signedAt);
  const signedBy = text(record.signedBy);
  if (signedAt === '' || signedBy === '') {
    return {
      ok: false,
      code: 'LIA_UNSIGNED',
      message:
        `Assessment ${record.id} has been written but not signed. An unsigned assessment is a ` +
        `draft, and a draft is not the thing Article 6(1)(f) asks for.`,
    };
  }
  if (Number.isNaN(Date.parse(signedAt))) {
    return {
      ok: false,
      code: 'LIA_MALFORMED',
      message: `Assessment ${record.id} has an unreadable signature date ${JSON.stringify(record.signedAt)}.`,
    };
  }

  const due = text(record.reviewDueAt);
  if (due !== '') {
    const dueMs = Date.parse(due);
    if (Number.isNaN(dueMs)) {
      return {
        ok: false,
        code: 'LIA_MALFORMED',
        message: `Assessment ${record.id} has an unreadable review date ${JSON.stringify(record.reviewDueAt)}.`,
      };
    }
    if (now.getTime() >= dueMs) {
      return {
        ok: false,
        code: 'LIA_EXPIRED',
        message:
          `Assessment ${record.id} was due for review at ${due} and that date has passed. The ` +
          `balancing test weighs what people reasonably expect, and expectations move; a ` +
          `signature does not stand indefinitely.`,
      };
    }
  }

  // A document that covers nothing supports nothing, and a console reporting it as "in force"
  // would be telling the truth in a way that misleads. `validateLiaDraft` refuses both of these,
  // so only a migration or a hand edit can produce one \u2014 which is exactly why the read path has
  // to check rather than assume. MALFORMED and not NOT_COVERED, because no contact is involved:
  // this is a statement about the document, not about anybody's country or route.
  const routes = normaliseSourceKinds(record.sourceKinds);
  // A DECLARED ROUTE OUTSIDE THE CLOSED LIST IS REPORTED, NOT SILENTLY TREATED AS "COVERS
  // NOTHING". The two look the same from a contact's point of view \u2014 both refuse \u2014 but they send
  // the author somewhere different. "Not covered" tells them to write the assessment for this
  // route; if the assessment already exists and its stored `sourceKinds` says `APOLLO`, they
  // would be writing a document they already have. Unlike a country code, a route is drawn from
  // a list this system owns, so an entry outside it means the stored document and this code
  // disagree about what routes exist \u2014 and that disagreement is the thing worth saying.
  //
  // `validateLiaDraft` cannot produce one; a migration or a hand edit can, which is precisely
  // why the read path checks rather than trusts.
  if (routes === null) {
    return {
      ok: false,
      code: 'LIA_MALFORMED',
      message:
        `Assessment ${record.id} declares a route this system does not recognise ` +
        `(${JSON.stringify(record.sourceKinds)}). The recognised routes are ` +
        `${LEAD_SOURCE_KINDS.join(', ')}. An unrecognised declaration is not a wildcard, and it ` +
        `is not the same as covering no route: it means this document and this code disagree ` +
        `about what routes exist.`,
    };
  }


  const declaresCountry = Array.isArray(record.countries) && record.countries.length > 0;
  const declaresRoute = routes.length > 0;
  if (!declaresCountry || !declaresRoute) {
    return {
      ok: false,
      code: 'LIA_MALFORMED',
      message:
        `Assessment ${record.id} declares ` +
        `${declaresCountry ? '' : 'no jurisdiction'}${!declaresCountry && !declaresRoute ? ' and ' : ''}` +
        `${declaresRoute ? '' : 'no route of acquisition'}, so there is no contact it could ` +
        `support. An assessment covering "everywhere, however we got it" covers nothing.`,
    };
  }

  return {
    ok: true,
    record,
    sourceKinds: routes,
    id: record.id,
    title: text(record.title),
    signedBy,
    signedAt,
    reviewDueAt: due === '' ? null : due,
  };
}

/**
 * Does this assessment support sending to a contact in `country`, acquired by `source`, at `now`?
 *
 * Pure, and takes the record rather than an id, so the whole decision can be exercised without a
 * datastore. The caller resolves the id; this decides what the resolution means. A missing
 * record is passed as `null` rather than as an exception, because "no such assessment" is an
 * ordinary answer here and an ordinary answer should not need a catch.
 *
 * COVERAGE HAS TWO DIMENSIONS, AND FOR A WHILE THIS FUNCTION ONLY CHECKED ONE.
 * It checked country and stopped, so two assessments both covering `GB` were interchangeable:
 * a person identified on LinkedIn could cite the assessment written for practices scraped from
 * their own websites and nothing objected. `source` is now part of the question, and it is a
 * REQUIRED field of the context rather than an optional one \u2014 an optional one would have meant
 * every existing caller silently skipping the check, which is the gap itself with a type on it.
 * Making it required means the compiler, not a reviewer, is what finds a caller who forgot.
 *
 * ORDER IS DELIBERATE. Liveness comes first entire \u2014 withdrawn before expiry, and both before
 * any coverage question \u2014 so the message an operator sees names the most fundamental problem
 * rather than the first one the code happened to notice. Telling someone their assessment does
 * not cover France, when it was withdrawn last March, would send them to fix the wrong thing.
 * Country precedes source only because it is the coarser of the two; both are coverage and
 * neither outranks the other.
 */
export function assessmentVerdict(
  record: LiaRecord | null,
  context: { readonly country: string; readonly source: unknown; readonly now: Date }
): AssessmentVerdict {
  const live = livenessVerdict(record, context.now);
  if (!live.ok) return live;

  const country = typeof context.country === 'string' ? context.country.trim().toUpperCase() : '';
  const covered = Array.isArray(live.record.countries)
    ? live.record.countries.map((c) => text(c).toUpperCase())
    : [];
  if (country === '' || !covered.includes(country)) {
    return {
      ok: false,
      code: 'LIA_COUNTRY_NOT_COVERED',
      message:
        `Assessment ${live.id} covers ${covered.join(', ')} ` +
        `and this contact is in ${country === '' ? 'an unstated country' : country}. The ` +
        `balancing test differs by jurisdiction, so coverage is not transferable.`,
    };
  }

  // The second dimension of coverage. An unclassifiable source and an uncovered one are separate
  // codes because they have separate remedies: the first means this contact\u2019s provenance string
  // is a shape nothing here understands, and the second means the assessment simply was not
  // written about this route.
  const kind = classifyLeadSource(context.source);
  if (kind === null) {
    return {
      ok: false,
      code: 'LIA_SOURCE_UNKNOWN',
      message:
        `This contact records its source as ${JSON.stringify(context.source)}, which is not a ` +
        `route this system recognises, so no assessment can be shown to cover it. The ` +
        `recognised routes are ${LEAD_SOURCE_KINDS.join(', ')}. An unrecognised route refuses ` +
        `rather than borrowing the justification written for a recognised one.`,
    };
  }
  if (!live.sourceKinds.includes(kind)) {
    return {
      ok: false,
      code: 'LIA_SOURCE_NOT_COVERED',
      message:
        `Assessment ${live.id} covers ${live.sourceKinds.join(', ')} and ` +
        `this contact was obtained by ${kind} \u2014 ${LEAD_SOURCE_KIND_NOTES[kind]}. The balancing ` +
        `test weighs what the person reasonably expected, and that expectation follows the ` +
        `route: an assessment written about one is not evidence about another. Write the ` +
        `assessment that covers ${kind}, or correct this contact\u2019s source.`,
    };
  }

  return {
    ok: true,
    id: live.id,
    title: live.title,
    signedBy: live.signedBy,
    signedAt: live.signedAt,
    reviewDueAt: live.reviewDueAt,
    sourceKind: kind,
  };
}
