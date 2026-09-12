/**
 * S37 — what a model call costs, from the provider's published prices.
 *
 * WHAT WAS MISSING
 * ----------------
 * `BudgetTracker` had a `maxCostPerReply: 0.10` — a float, in dollars, that nothing enforced —
 * and the run log recorded `costMinor: null` with a sentence explaining that no price table
 * existed. That sentence was true. The only alternative at the time was to invent figures, which
 * is what the fabricated `£0.01` this replaced had done.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Google's Gemini API pricing page, paid tier, text tokens, USD per million, as it read on the
 * date below. The page is dated. Prices change; when they do, this table is re-read from the
 * same page and the date moves — the figures are the provider's to set and ours to copy, which
 * is why the tests pin the table's SHAPE and its arithmetic and not the numbers themselves.
 *
 * WHAT IS DELIBERATELY CONSERVATIVE, AND WHY
 * ------------------------------------------
 *  - Output pricing includes thinking tokens on every listed model, and the provider reports
 *    thoughts separately (`thoughtsTokenCount`). Billable output is therefore candidates PLUS
 *    thoughts; when only a total is known it is total minus prompt, which includes them too.
 *  - A model that is not in the table is charged at the most expensive listed rate, and the
 *    cost is marked an UPPER BOUND. `gemini-flash-latest` is one of the client's failover
 *    candidates and is not on the page under that name.
 *  - A call rounds UP to a whole cent. A budget that rounds down can be exceeded by a thousand
 *    cheap calls that each rounded to nothing.
 *  - The long-context tier and the announced rate change are applied from the call's own prompt
 *    size and the call's own time. Neither is a flag somebody has to remember to flip.
 *
 * Amounts are integers in USD cents, the provider's currency. Converting to the price book's
 * GBP would need an exchange rate, and inventing one is the same mistake as inventing a price.
 */

export const PRICING_SOURCE = {
  url: 'https://ai.google.dev/gemini-api/docs/pricing',
  tier: 'paid',
  currency: 'USD',
  /** The page's own "last updated" date, UTC. */
  pageDated: '2026-09-11',
  /** When this table was copied from it. */
  readOn: '2026-09-12',
} as const;

export interface ModelPrice {
  readonly model: string;
  /** Cents per 1,000,000 input tokens. */
  readonly inputCentsPerMillion: number;
  /** Cents per 1,000,000 output tokens, thinking included. */
  readonly outputCentsPerMillion: number;
  /** Prompts LARGER than this many tokens are billed at the long-context rates, or null. */
  readonly longContextAbove: number | null;
  readonly longContextInputCentsPerMillion: number | null;
  readonly longContextOutputCentsPerMillion: number | null;
  /** An announced change: these rates apply to calls made on or after `date` (ISO, UTC). */
  readonly changesOn: {
    readonly date: string;
    readonly inputCentsPerMillion: number;
    readonly outputCentsPerMillion: number;
  } | null;
}

export const MODEL_PRICES: readonly ModelPrice[] = [
  {
    model: 'gemini-3.1-pro-preview',
    inputCentsPerMillion: 200,
    outputCentsPerMillion: 1200,
    longContextAbove: 200_000,
    longContextInputCentsPerMillion: 400,
    longContextOutputCentsPerMillion: 1800,
    changesOn: null,
  },
  {
    model: 'gemini-3.7-flash',
    inputCentsPerMillion: 75,
    outputCentsPerMillion: 375,
    longContextAbove: null,
    longContextInputCentsPerMillion: null,
    longContextOutputCentsPerMillion: null,
    changesOn: { date: '2027-01-01', inputCentsPerMillion: 150, outputCentsPerMillion: 750 },
  },
  {
    model: 'gemini-3.1-flash-lite',
    inputCentsPerMillion: 25,
    outputCentsPerMillion: 150,
    longContextAbove: null,
    longContextInputCentsPerMillion: null,
    longContextOutputCentsPerMillion: null,
    changesOn: null,
  },
];

/** What a call reported. Every field independently unknown, exactly as the provider left it. */
export interface CallUsage {
  readonly model: string | null;
  readonly promptTokens: number | null;
  readonly outputTokens: number | null;
  readonly thoughtsTokens: number | null;
  readonly totalTokens: number | null;
}

export interface CallCost {
  /** Whole cents, rounded up; null when the provider reported too little to price the call. */
  readonly costMinor: number | null;
  readonly currency: 'USD';
  /** True when the figure is a ceiling rather than the price: an unlisted model, or output inferred from a total. */
  readonly upperBound: boolean;
  /** One line saying how the figure was arrived at, for the operator reading a run log. */
  readonly basis: string;
}

/**
 * Billable input and output tokens for a call, or null where the provider said too little.
 * Output includes thinking. Never fills a missing breakdown with a zero.
 */
export function billableTokens(usage: CallUsage): {
  input: number | null;
  output: number | null;
  outputInferred: boolean;
} {
  const input = usage.promptTokens;
  if (usage.outputTokens !== null) {
    if (usage.thoughtsTokens !== null) {
      return { input, output: usage.outputTokens + usage.thoughtsTokens, outputInferred: false };
    }
    // Thoughts unreported. If a total is known, total − prompt includes them; take the larger.
    if (usage.totalTokens !== null && input !== null) {
      return { input, output: Math.max(usage.outputTokens, usage.totalTokens - input), outputInferred: true };
    }
    return { input, output: usage.outputTokens, outputInferred: false };
  }
  if (usage.totalTokens !== null && input !== null) {
    return { input, output: Math.max(0, usage.totalTokens - input), outputInferred: true };
  }
  return { input, output: null, outputInferred: false };
}

/** The most expensive listed rates: what an unlisted model is charged at. */
function dearestListed(): ModelPrice {
  return MODEL_PRICES.reduce((dearest, p) =>
    p.outputCentsPerMillion > dearest.outputCentsPerMillion ? p : dearest
  );
}

/** The table row for a model, or the dearest row with `listed: false` when there is none. */
export function priceFor(model: string | null): { price: ModelPrice; listed: boolean } {
  const listed = model === null ? undefined : MODEL_PRICES.find((p) => p.model === model);
  return listed ? { price: listed, listed: true } : { price: dearestListed(), listed: false };
}

/** The rates that apply to one call, given its prompt size and when it was made. */
export function ratesFor(
  price: ModelPrice,
  promptTokens: number,
  at: Date
): { inputCentsPerMillion: number; outputCentsPerMillion: number; tier: string } {
  if (price.longContextAbove !== null && promptTokens > price.longContextAbove) {
    return {
      inputCentsPerMillion: price.longContextInputCentsPerMillion ?? price.inputCentsPerMillion,
      outputCentsPerMillion: price.longContextOutputCentsPerMillion ?? price.outputCentsPerMillion,
      tier: `long-context (>${price.longContextAbove} prompt tokens)`,
    };
  }
  if (price.changesOn !== null && at.toISOString().slice(0, 10) >= price.changesOn.date) {
    return {
      inputCentsPerMillion: price.changesOn.inputCentsPerMillion,
      outputCentsPerMillion: price.changesOn.outputCentsPerMillion,
      tier: `rates from ${price.changesOn.date}`,
    };
  }
  return {
    inputCentsPerMillion: price.inputCentsPerMillion,
    outputCentsPerMillion: price.outputCentsPerMillion,
    tier: 'standard',
  };
}

/**
 * The cost of one call in whole cents, rounded up, or null if the provider reported too little.
 * Integer arithmetic throughout: tokens × cents-per-million, divided by a million, ceiling.
 */
export function costOfCall(usage: CallUsage, at: Date = new Date()): CallCost {
  const tokens = billableTokens(usage);
  if (tokens.input === null || tokens.output === null) {
    return {
      costMinor: null,
      currency: 'USD',
      upperBound: false,
      basis: 'unpriced: the provider did not report enough usage to price this call',
    };
  }
  const { price, listed } = priceFor(usage.model);
  const rates = ratesFor(price, tokens.input, at);
  const cents = Math.ceil(
    (tokens.input * rates.inputCentsPerMillion + tokens.output * rates.outputCentsPerMillion) / 1_000_000
  );
  const notes: string[] = [`${price.model} ${rates.tier}`];
  if (!listed) notes.push(`${usage.model ?? 'no model'} is not listed; charged at the dearest listed rate`);
  if (tokens.outputInferred) notes.push('output inferred from the total, thoughts unreported');
  return {
    costMinor: cents,
    currency: 'USD',
    upperBound: !listed || tokens.outputInferred,
    basis: notes.join('; '),
  };
}
