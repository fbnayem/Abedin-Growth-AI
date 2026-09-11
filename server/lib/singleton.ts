/**
 * THE TWO SINGLETON DOCUMENTS, AND WHAT A PARTIAL UPDATE MEANS.
 *
 * WHAT WAS WRONG
 * --------------
 * `apiContracts.ts` says of the company brain and the settings: "Every field is optional: these are
 * partial updates to a singleton, not full replacements." The handler did the opposite.
 *
 *     const outcome = await mutateWithVersion(ref, expected.value, () => body);
 *
 * `mutateWithVersion` writes the document WHOLE — deliberately, so that a field removed by
 * `produceNext` is genuinely removed, which is what lets a mutation delete a value. So
 * `POST /api/company-brain` with `{ tagline: "..." }` — exactly what the schema invites, and
 * exactly what the brain editor sends — would have replaced the organisation's entire company
 * brain with one field. Every persona, objection answer and narrative, gone, at version + 1.
 *
 * Nothing had ever sent one, because no UI wrote to that endpoint at all: the brain editor's Save
 * button only called `setState`. So the contract said partial, the handler did whole, and the gap
 * was invisible because the feature was never wired up.
 *
 * WHY THE MERGE LIVES HERE AND NOT IN `mutateWithVersion`
 * ------------------------------------------------------
 * Whole-document replacement is the right primitive and several callers depend on it. "Partial"
 * is a property of THIS route's contract, so it is composed at this level: the handler hands
 * `mutateWithVersion` a function that merges, and the primitive still writes whatever it is given,
 * whole.
 */

/**
 * Fields that govern a write and must never be stored as document content.
 *
 * `version` and `updatedAt` are stamped by `mutateWithVersion` after `produceNext` returns, so
 * carrying them forward from the current document would be writing a value that is about to be
 * overwritten — harmless today, and precisely the kind of thing that stops being harmless when
 * somebody changes the stamping order.
 */
const STAMPED_BY_THE_WRITER = ['version', 'updatedAt'] as const;

/**
 * The document to store: the current one, with the validated body applied over it.
 *
 * `current` is `null` when the document does not exist yet, in which case the body IS the document.
 */
export function mergeSingletonBody(
  current: Record<string, unknown> | null,
  body: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(current ?? {}), ...body };
  for (const field of STAMPED_BY_THE_WRITER) delete merged[field];
  return merged;
}
