/**
 * P0.8 — A provider id must come from a provider.
 *
 * Ids shaped like `sim_`, `mock_` or `test_` were previously minted locally and written to
 * durable records with status SENT, which made every "successful send" in the system
 * unfalsifiable. Nothing matching this may be persisted as evidence that an external action
 * occurred, and nothing matching this may be accepted as evidence that one DID occur when
 * reconciling an ambiguous outcome (§32) — a fabricated id is not a weaker proof of delivery
 * than a real one, it is not a proof of delivery at all.
 *
 * This lives in `lib/` rather than in the gateway because reconciliation needs the same rule
 * and importing the gateway from it would close a cycle. One definition, one test target.
 */

export const FABRICATED_PROVIDER_ID = /^(sim|mock|test|fake|stub)[-_]/i;

export function isFabricatedProviderId(id: unknown): boolean {
  return typeof id === 'string' && FABRICATED_PROVIDER_ID.test(id);
}
