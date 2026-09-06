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
