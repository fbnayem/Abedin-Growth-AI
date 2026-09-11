/**
 * THE UNIONS THIS SYSTEM CAN CHECK AT RUNTIME, AND WHY THEY HAD TO BECOME LISTS.
 *
 * `InvestorStage`, `InvestorStatus`, `PartnerType`, `PartnerStatus` and `LeadStatus` were declared
 * as TypeScript unions and nothing else — so they existed at compile time and vanished at runtime.
 * The three discovery agents take MODEL OUTPUT and put it in those fields:
 *
 *     stage: (item.stage || stage) as any,
 *     status: (item.status as any) || "DISCOVERED",
 *     partnerType: (item.partnerType || partnerType) as any,
 *
 * The cast is the whole check. A model that answers `"Series A"`, `"seed"`, `"PROSPECTING"` or a
 * sentence puts that value straight into a typed field, and every consumer that switches on it — a
 * status badge, a filter, a stage comparison — silently takes no branch. It is the same shape as
 * the company brain's `workspaceId`: model output landing in a field the server owns, with a cast
 * where the validation should be.
 *
 * Declaring the members as a `const` array and deriving the type from it keeps ONE source of truth
 * — add a member and the type widens with it — and makes the set available at runtime, which is
 * the only place a check can happen.
 */

export const INVESTOR_STAGES = ['PRE_SEED', 'SEED', 'SERIES_A', 'SERIES_B', 'GROWTH', 'ANGEL'] as const;
export type InvestorStage = (typeof INVESTOR_STAGES)[number];

export const INVESTOR_STATUSES = [
  'DISCOVERED',
  'QUALIFIED',
  'CONTACTED',
  'REPLIED',
  'MEETING_BOOKED',
  'DUE_DILIGENCE',
  'TERM_SHEET',
  'COMMITTED',
  'PASSED',
] as const;
export type InvestorStatus = (typeof INVESTOR_STATUSES)[number];

export const PARTNER_TYPES = [
  'RESELLER',
  'REFERRAL',
  'TELECOM',
  'AGENCY',
  'CRM_CONSULTANT',
  'BPO_CALL_CENTER',
  'TECHNOLOGY_INTEGRATION',
  'STRATEGIC',
] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const PARTNER_STATUSES = [
  'DISCOVERED',
  'QUALIFIED',
  'CONTACTED',
  'CONVERSATION',
  'MEETING',
  'PROPOSAL',
  'NEGOTIATION',
  'ACTIVE_PARTNER',
  'DECLINED',
] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

export const LEAD_STATUSES = [
  'NEW',
  'QUALIFIED',
  'CONTACTED',
  'ENGAGED',
  'DEMO_SCHEDULED',
  'MEETING_SCHEDULED',
  'DEMO_COMPLETED',
  'PROPOSAL_SENT',
  'PILOT',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
  'UNSUBSCRIBED',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/**
 * The value when it is a member of the list, and the fallback when it is not.
 *
 * The fallback is a PARAMETER rather than a default inside this function, because what an
 * unrecognised value should become differs by field and is a decision each caller has to make
 * visibly: an unknown investor status becomes DISCOVERED, the least-progressed state, so nothing is
 * claimed about a relationship that may not exist.
 *
 * Case is NOT normalised, and near-misses are NOT repaired. `"seed"` does not become `SEED` here:
 * these values arrive from a model, and quietly accepting a near-miss is how one state comes to be
 * spelled four ways in one table. The fallback is visible in the record; a coerced value is not.
 */
export function memberOf<T extends string>(members: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (members as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
