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
  /** What categories of personal data are processed: "name", "work email", "job title". */
  readonly dataCategories: readonly string[];
  /** Where the data comes from: "company website contact pages", "CSV from a trade directory". */
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
  | 'LIA_MALFORMED';

export type AssessmentVerdict =
  | {
      readonly ok: true;
      readonly id: string;
      readonly title: string;
      readonly signedBy: string;
      readonly signedAt: string;
      readonly reviewDueAt: string | null;
    }
  | { readonly ok: false; readonly code: LiaRefusalCode; readonly message: string };

export type DraftRefusalCode =
  | 'LIA_LIMB_TOO_SHORT'
  | 'LIA_LIMB_TOO_LONG'
  | 'LIA_NO_COUNTRIES'
  | 'LIA_COUNTRY_UNKNOWN'
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
 * Does this assessment support sending to a contact in `country`, as at `now`?
 *
 * Pure, and takes the record rather than an id, so the whole decision can be exercised without a
 * datastore. The caller resolves the id; this decides what the resolution means. A missing
 * record is passed as `null` rather than as an exception, because "no such assessment" is an
 * ordinary answer here and an ordinary answer should not need a catch.
 *
 * ORDER IS DELIBERATE. Withdrawn is checked before expiry, and both before country coverage, so
 * the message an operator sees names the most fundamental problem rather than the first one the
 * code happened to notice. Telling someone their assessment does not cover France, when it was
 * withdrawn last March, would send them to fix the wrong thing.
 */
export function assessmentVerdict(
  record: LiaRecord | null,
  context: { readonly country: string; readonly now: Date }
): AssessmentVerdict {
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
        `— write the assessment that replaces it.`,
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
    if (context.now.getTime() >= dueMs) {
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

  const country = typeof context.country === 'string' ? context.country.trim().toUpperCase() : '';
  const covered = Array.isArray(record.countries)
    ? record.countries.map((c) => text(c).toUpperCase())
    : [];
  if (country === '' || !covered.includes(country)) {
    return {
      ok: false,
      code: 'LIA_COUNTRY_NOT_COVERED',
      message:
        `Assessment ${record.id} covers ${covered.length === 0 ? 'no country' : covered.join(', ')} ` +
        `and this contact is in ${country === '' ? 'an unstated country' : country}. The ` +
        `balancing test differs by jurisdiction, so coverage is not transferable.`,
    };
  }

  return {
    ok: true,
    id: record.id,
    title: text(record.title),
    signedBy,
    signedAt,
    reviewDueAt: due === '' ? null : due,
  };
}
