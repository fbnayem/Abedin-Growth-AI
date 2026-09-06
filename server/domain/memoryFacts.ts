import type { FactObservation } from './facts';

/**
 * P1.6 — Turning a synthesised ConversationMemory into recordable facts (§20, §21, §18).
 *
 * THE CRASH THIS REPLACES
 * -----------------------
 * The pipeline iterated `(memory as any).facts`. `ConversationMemory` has no `facts` member,
 * so the loop threw on `undefined` — after the delete above it had already erased the
 * conversation's history. The `as any` is why the compiler never mentioned that the member
 * does not exist.
 *
 * WHY EVERYTHING HERE IS AGENT_SYNTHESIS
 * --------------------------------------
 * Every field of a ConversationMemory is a model's summary of a customer's email. None of it
 * is something the customer wrote; it is something a model said the customer meant. That is
 * the lowest authority tier, and it must stay there, because these facts are read back into
 * later prompts. A model's paraphrase presented as a stored fact is how one injected sentence
 * in an inbound email becomes a durable instruction the system keeps repeating to itself (§18).
 *
 * WHY LISTS BECOME ONE FACT AND NOT MANY
 * --------------------------------------
 * Supersession needs a stable key. "Pain point #2" is not stable — the model may reorder, and
 * the second element changing would read as the customer changing their mind about something
 * they never said. The stable claim is the SET: `pain_points` supersedes as a whole when the
 * set changes, and is confirmed when it does not.
 */

/** Normalise a list to a stable, comparable string: trimmed, de-duplicated, order preserved. */
function normalizeList(values: unknown): string | null {
  if (!Array.isArray(values)) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    items.push(trimmed);
  }
  return items.length === 0 ? null : JSON.stringify(items);
}

/** The list-valued memory fields, and the fact key each becomes. */
const LIST_FIELDS: { field: string; key: string }[] = [
  { field: 'keyPainPoints', key: 'pain_points' },
  { field: 'mentionedPreferences', key: 'stated_preferences' },
  { field: 'objectionsResolved', key: 'objections_resolved' },
  { field: 'commitmentsMade', key: 'commitments_made' },
  { field: 'agreedTimeSlots', key: 'agreed_time_slots' },
];

/**
 * Derive fact observations from a synthesised memory.
 *
 * `sourceMessageId` is required rather than optional: every one of these is attributed to the
 * message that produced it, and a fact that cannot answer "who told us this and when" is
 * refused by the validator rather than stored unattributed.
 */
export function observationsFromMemory(
  memory: unknown,
  sourceMessageId: string,
  options: { observedAt?: string } = {}
): FactObservation[] {
  if (memory === null || typeof memory !== 'object') return [];

  const source = memory as Record<string, unknown>;
  const observedAt = options.observedAt;
  const observations: FactObservation[] = [];

  const add = (key: string, value: string | null) => {
    if (value === null || value.trim().length === 0) return;
    observations.push({
      key,
      value,
      sourceType: 'AGENT_SYNTHESIS',
      sourceMessageId,
      // No confidence: the memory agent does not compute one, and inventing a number here
      // would give a model's paraphrase a precision it never had.
      confidence: null,
      observedAt,
      derivedFromUntrusted: true,
    });
  };

  for (const { field, key } of LIST_FIELDS) {
    add(key, normalizeList(source[field]));
  }

  if (typeof source.prospectSentiment === 'string') {
    add('prospect_sentiment', source.prospectSentiment);
  }

  // `keyFactsExtracted` is the one genuinely per-key structure in the memory, so each entry
  // supersedes independently — a changed renewal date does not disturb a stored headcount.
  const extracted = source.keyFactsExtracted;
  if (extracted !== null && typeof extracted === 'object' && !Array.isArray(extracted)) {
    for (const [rawKey, rawValue] of Object.entries(extracted as Record<string, unknown>)) {
      if (typeof rawValue !== 'string') continue;
      const key = rawKey.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      if (key.length === 0) continue;
      add(`extracted.${key}`, rawValue.trim());
    }
  }

  // The chronological summary is stored as one fact rather than one per line: it is a single
  // artefact that is rewritten wholesale each time the model runs.
  const summary = normalizeList(source.threadSummaryChronological);
  if (summary !== null) add('thread_summary', summary);

  return observations;
}
