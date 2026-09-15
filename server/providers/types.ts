/**
 * P1.11 — Adapter contracts (S41).
 *
 * Before this file, a grep for `interface [A-Za-z]*Provider` across the repository returned zero
 * hits. Each integration was a concrete class the gateway reached into directly, so there was no
 * statement anywhere of what an email provider is *obliged* to do — and therefore nothing a
 * second provider could be checked against, and nothing a test could substitute.
 *
 * The contract is deliberately narrow. It says what every provider must promise:
 *
 *   1. Failures arrive as `ProviderError`, already classified. An adapter that throws a bare
 *      `Error` pushes the §32 decision — "might this have happened anyway?" — back onto the
 *      caller, which is where the substring classifier came from.
 *
 *   2. A successful send returns a PROVIDER-issued id. Not one we minted. P0.8 found locally
 *      generated `sim_` ids being written to durable records as evidence of a real send, which
 *      made every "successful send" in the system unfalsifiable.
 *
 *   3. Capabilities are declared, so the gateway can refuse before the network rather than
 *      discovering a missing scope from a 403 after dispatch.
 */

import type { ProviderError } from '../lib/providerError';
import type { Capability } from '../lib/capabilities';

/** Common to every adapter. */
export interface ProviderAdapter {
  /** Stable identifier used in logs and in `ProviderError.provider`. */
  readonly providerName: string;
  /** What this adapter needs to be granted before any of its methods may be called. */
  readonly requiredCapabilities: readonly Capability[];
}

export interface SendEmailInput {
  to: string;
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface SendEmailOutput {
  /**
   * The id the PROVIDER returned. An adapter must never invent one: a fabricated id recorded as
   * evidence of a send cannot afterwards be distinguished from a real one (P0.8).
   */
  messageId: string;
  threadId: string;
}

/**
 * @throws {ProviderError} for every failure — never a bare Error. The kind carries whether the
 * message may have been delivered anyway, which is the only question a retry may ask (§32).
 */
export interface EmailProvider extends ProviderAdapter {
  sendEmail(input: SendEmailInput): Promise<SendEmailOutput>;
}

export interface CreateEventInput {
  title: string;
  description?: string;
  /** ISO-8601 with an offset. An offset-less string means different moments on different hosts. */
  startAtUtc: string;
  endAtUtc: string;
  /** IANA identifier. Never an abbreviation: "BST" resolves to Asia/Dhaka (P1.9). */
  timeZone: string;
  attendees: readonly string[];
  /**
   * P0.13 — the conference request id is derived from this, never from `Date.now()`.
   *
   * Google treats `conferenceData.createRequest.requestId` as an idempotency key: the same
   * value returns the same conference, a new value mints a second one. The old code passed
   * `"req_" + Date.now()`, so a retried booking produced a SECOND Google Meet for the same
   * meeting and the customer received two links for one appointment. Required, not optional:
   * an omitted key is how that defect comes back.
   */
  idempotencyKey: string;
}

export interface CreateEventOutput {
  eventId: string;
  conferenceUrl: string | null;
}

/**
 * Availability is deliberately three-valued.
 *
 * `checkFreeBusy` used to return `true` without contacting anything, and `true` from a free/busy
 * check means "the slot is free" — a claim that code was never in a position to make. UNKNOWN is
 * a real answer here, and §14 forbids a caller from reading it as permission.
 */
export type Availability = 'FREE' | 'BUSY' | 'UNKNOWN';

/** @throws {ProviderError} for every failure. */
export interface CalendarProvider extends ProviderAdapter {
  checkAvailability(input: {
    startAtUtc: string;
    endAtUtc: string;
    timeZone: string;
    attendees: readonly string[];
  }): Promise<{ availability: Availability; reason: string }>;

  createEvent(input: CreateEventInput): Promise<CreateEventOutput>;
}

/**
 * A credential an adapter can renew on its own. Separate from the adapter interfaces because not
 * every provider offers it, and pretending otherwise would put an unimplementable method on
 * adapters that then have to throw from it.
 */
export interface RefreshableCredential {
  refreshAccessToken(): Promise<{ accessToken: string; expiresAt: Date | null }>;
}

/** Compile-time proof that an implementation satisfies a contract, with no runtime cost. */
export type Implements<TContract, TImpl extends TContract> = TImpl;

export type { ProviderError, Capability };

/**
 * P2c — DISCOVERY: finding contacts that are not yet in the database.
 *
 * The narrowest contract that lets the service refuse before the network and account for what
 * was spent afterwards. Three obligations beyond the common ones:
 *
 *   1. `providerRecordId` IS THE PROVIDER'S. Never minted here. The same rule P0.8 established
 *      for message ids, for the same reason: an id this system invented cannot afterwards be
 *      distinguished from one a provider returned, so "where did this lead come from?" stops
 *      having a checkable answer.
 *
 *   2. THE COST IS REPORTED, NOT ESTIMATED BY THE CALLER. A provider knows what it charged; a
 *      caller guessing lets a tenant's ledger drift from the invoice. Where the provider will
 *      not say, the adapter reports a CEILING and flags it, so the spend gate errs towards
 *      refusing rather than towards overspending.
 *
 *   3. FAILURES ARE `ProviderError`, ALREADY CLASSIFIED. A discovery lookup that times out may
 *      still have been charged, which is the §32 question — and a bare Error pushes it back on
 *      a caller that has no way to answer it.
 */
export interface DiscoveryQuery {
  /** ISO-3166 alpha-2. The basis gate refuses an unknown country, so this is not optional. */
  readonly country: string;
  readonly industry?: string;
  readonly titles?: readonly string[];
  readonly companySizeMin?: number;
  readonly companySizeMax?: number;
  /** The most records to return. A provider that returns more has broken its contract. */
  readonly limit: number;
}

export interface DiscoveredRecord {
  /** The PROVIDER's id for this record. Never minted by this system. */
  readonly providerRecordId: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly title?: string;
  readonly companyName?: string;
  readonly companyWebsite?: string;
  readonly industry?: string;
  readonly country?: string;
  readonly employeeCount?: string;
  readonly linkedinUrl?: string;
  /** Where the provider says it got this, if it says. Stored as evidence, never as authority. */
  readonly sourceUrl?: string;
}

export interface DiscoverOutput {
  readonly records: readonly DiscoveredRecord[];
  /** What the provider charged, in USD cents. */
  readonly costMinor: number;
  /** True when the adapter could only bound the cost. The ledger then holds a ceiling. */
  readonly costIsUpperBound: boolean;
  /** The provider's own id for this lookup, so a result can be traced back to its query. */
  readonly queryId: string;
}

/** @throws {ProviderError} for every failure. */
export interface DiscoveryProvider extends ProviderAdapter {
  /** What this provider can filter on. A query using anything else is refused before the call. */
  readonly supportedFilters: readonly (keyof DiscoveryQuery)[];
  discover(input: DiscoveryQuery): Promise<DiscoverOutput>;
}
