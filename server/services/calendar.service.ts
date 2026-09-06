import { config } from '../config/environment';
import { fetchWithTimeout } from '../lib/httpClient';
import { classifyResponse, classifyThrown, ProviderError } from '../lib/providerError';
import type {
  Availability,
  CalendarProvider,
  CreateEventInput,
  CreateEventOutput,
} from '../providers/types';
import type { Capability } from '../lib/capabilities';
import {
  DEFAULT_BUSINESS_HOURS,
  assertTimeZone,
  isWithinBusinessHours,
  parseInstant,
  type BusinessHours,
} from '../../shared/domain/time';
import { createHash } from 'crypto';

/**
 * S41 / S31 — the calendar adapter that did not exist.
 *
 * WHAT WAS WRONG
 * --------------
 * `CalendarProvider` was declared in P1.11 and a repo-wide search for `implements
 * CalendarProvider` returned **zero hits**. Three disjoint pieces of calendar code existed and
 * none of them declared the contract, so nothing could be checked against it and nothing could
 * be substituted for it in a test:
 *
 *   1. `CalendarService` here — orphaned. Zero importers. `checkFreeBusy` took four parameters,
 *      used one, contacted nothing and returned UNKNOWN. `createMeeting` threw bare `Error`s
 *      that `classifyThrown` cannot read (it deliberately never reads `message`), so every
 *      calendar failure classified UNKNOWN -> AMBIGUOUS. It defaulted `conferenceUrl` to
 *      `"https://meet.google.com/"` — the Google Meet HOMEPAGE — when the provider returned no
 *      conference, handing the customer a link to nothing that looked exactly like a link to
 *      something.
 *   2. `ActionGateway.executeCalendarCreate` — unreachable, and inside it
 *      `const hasConflict = fbData.calendars?.primary?.busy?.length > 0;` was **assigned and
 *      never read**. The free/busy call was made, parsed, and the answer thrown away; the
 *      event was created regardless. There was also no `fbRes.ok` check, so a 401 body has no
 *      `.calendars` and the discarded answer would have been `false` — "free" — anyway.
 *   3. `POST /api/meetings` — the only path that runs, and it never contacts a provider.
 *
 * §31 asks one question: when free/busy says busy, how many create requests are issued? The
 * honest answer was "the question is not asked on any reachable path, and where it is asked the
 * answer is discarded".
 *
 * THE CONTRACT
 * ------------
 * This class now declares `CalendarProvider`, so the compiler checks it. Availability is
 * three-valued and every value is reachable: FREE and BUSY come from a provider answer we could
 * read, UNKNOWN from one we could not. UNKNOWN is not a formality — Google returns per-calendar
 * `errors` for calendars the credential cannot see, which is the ordinary case for an
 * attendee's calendar, and reporting that as FREE would be a fabricated availability claim.
 */

/** Google returns per-calendar errors inside a 200. An unreadable calendar is not a free one. */
interface FreeBusyCalendar {
  busy?: Array<{ start?: string; end?: string }>;
  errors?: Array<{ domain?: string; reason?: string }>;
}

export class GoogleCalendarService implements CalendarProvider {
  readonly providerName = 'google-calendar';
  readonly requiredCapabilities: readonly Capability[] = ['CALENDAR_WRITE'];

  private accessToken: string | null = null;

  setCredentials(tokens: { access_token: string }) {
    this.accessToken = tokens.access_token;
  }

  private requireToken(operation: string): string {
    if (!this.accessToken) {
      throw new ProviderError({
        provider: this.providerName,
        operation,
        kind: 'PERMISSION_DENIED',
        signal: 'no access token set',
      });
    }
    return this.accessToken;
  }

  /**
   * S31 — the answer this returns is the one that decides whether an event is created.
   *
   * Three values, and the caller may only proceed on FREE. UNKNOWN exists because "we asked and
   * could not read the answer" is a real outcome that must not be laundered into "the slot is
   * free" (§14) — which is exactly what the discarded `hasConflict` boolean did, since a failed
   * free/busy response has no `.calendars` and yielded `false`.
   */
  async checkAvailability(input: {
    startAtUtc: string;
    endAtUtc: string;
    timeZone: string;
    attendees: readonly string[];
  }): Promise<{ availability: Availability; reason: string }> {
    assertTimeZone(input.timeZone);
    const token = this.requireToken('checkAvailability');

    // Every calendar we are about to claim something about is asked about. Omitting the
    // attendees and then reporting FREE would be a claim about calendars we never queried.
    const items = [{ id: 'primary' }, ...input.attendees.map((email) => ({ id: email }))];

    let res: Response;
    try {
      res = await fetchWithTimeout('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeMin: parseInstant(input.startAtUtc).toISOString(),
          timeMax: parseInstant(input.endAtUtc).toISOString(),
          timeZone: input.timeZone,
          items,
        }),
      });
    } catch (e) {
      throw classifyThrown(e, { provider: this.providerName, operation: 'checkAvailability' });
    }

    // The missing `res.ok` check. Without it a 401 body parses to `{}`, `.calendars` is
    // undefined, and the answer reads as "nobody is busy".
    if (!res.ok) {
      throw classifyResponse(res, { provider: this.providerName, operation: 'checkAvailability' });
    }

    const data: any = await res.json();
    const calendars: Record<string, FreeBusyCalendar> =
      data && typeof data.calendars === 'object' && data.calendars !== null ? data.calendars : {};

    const asked = items.map((i) => i.id);
    const missing = asked.filter((id) => calendars[id] === undefined);
    const unreadable = asked.filter((id) => (calendars[id]?.errors?.length ?? 0) > 0);

    // BUSY first: a definite conflict on ANY calendar we could read is a definite conflict,
    // and it is worth more than the fact that some other calendar was unreadable.
    const busyOn = asked.filter((id) => (calendars[id]?.busy?.length ?? 0) > 0);
    if (busyOn.length > 0) {
      return {
        availability: 'BUSY',
        reason: `Busy on ${busyOn.length} of ${asked.length} calendar(s): ${busyOn.join(', ')}.`,
      };
    }

    if (missing.length > 0 || unreadable.length > 0) {
      return {
        availability: 'UNKNOWN',
        reason:
          `Availability could not be established for ${missing.length + unreadable.length} of ` +
          `${asked.length} calendar(s) (${[...missing, ...unreadable].join(', ')}). ` +
          'A calendar we cannot read is not a calendar that is free.',
      };
    }

    return {
      availability: 'FREE',
      reason: `All ${asked.length} calendar(s) reported no busy intervals in the window.`,
    };
  }

  /**
   * P1.9 — this read `startTime.getUTCHours()` into an unused variable and returned `true`.
   * A validator that returns true for every input is worse than no validator: every caller
   * reads it as a check that passed.
   */
  validateBusinessHours(
    startTime: Date,
    timeZone: string,
    hours: BusinessHours = DEFAULT_BUSINESS_HOURS
  ): { valid: boolean; reason: string | null; localTime: string } {
    assertTimeZone(timeZone);
    const verdict = isWithinBusinessHours(startTime, { ...hours, timeZone });
    return {
      valid: verdict.within,
      reason: verdict.within === true ? null : verdict.reason,
      localTime: verdict.localTime,
    };
  }

  /**
   * P0.13 — the conference request id is derived, not stamped from the clock.
   *
   * Google treats `requestId` as an idempotency key. `"req_" + Date.now()` meant a retried
   * booking minted a SECOND Google Meet conference for one meeting, and the customer received
   * two links. Hashed so an internal key does not travel to a third party in the clear.
   */
  static conferenceRequestId(idempotencyKey: string): string {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new ProviderError({
        provider: 'google-calendar',
        operation: 'createEvent',
        kind: 'INVALID_REQUEST',
        signal:
          'no idempotency key, so the conference request id would have to be minted from the ' +
          'clock — and a retry would then create a second conference for one meeting',
      });
    }
    return 'ag-' + createHash('sha256').update(idempotencyKey.trim(), 'utf8').digest('hex').slice(0, 32);
  }

  async createEvent(input: CreateEventInput): Promise<CreateEventOutput> {
    assertTimeZone(input.timeZone);
    const requestId = GoogleCalendarService.conferenceRequestId(input.idempotencyKey);

    if (config.demoMode) {
      // P0.8 — retained for local development, and deliberately shaped so it CANNOT be
      // laundered into a durable booked record: the `sim_` prefix is matched by
      // isFabricatedProviderId(), and the gateway refuses any calendar result carrying one.
      // If you change this prefix, change that guard too.
      console.warn(
        '[DEMO MODE] Simulating calendar event creation. This produces a fabricated event id ' +
          'which the gateway MUST reject; it can never be recorded as a booked meeting.'
      );
      return { eventId: `sim_event_${requestId}`, conferenceUrl: null };
    }

    const token = this.requireToken('createEvent');

    let res: Response;
    try {
      res = await fetchWithTimeout(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary: input.title,
            description: input.description,
            start: { dateTime: parseInstant(input.startAtUtc).toISOString(), timeZone: input.timeZone },
            end: { dateTime: parseInstant(input.endAtUtc).toISOString(), timeZone: input.timeZone },
            attendees: input.attendees.map((email) => ({ email })),
            conferenceData: {
              createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } },
            },
          }),
        }
      );
    } catch (e) {
      throw classifyThrown(e, { provider: this.providerName, operation: 'createEvent' });
    }

    if (!res.ok) {
      // Was `throw new Error(\`Failed to create calendar event: ${res.status} ...\`)`. The
      // status was in the prose, and `classifyThrown` never reads prose — by design, because
      // reading it is how a customer's email subject once steered the classification (§18).
      // Every calendar failure therefore classified UNKNOWN, hence AMBIGUOUS, hence
      // un-retryable: a clean 403 was escalated to "this may have happened".
      throw classifyResponse(res, { provider: this.providerName, operation: 'createEvent' });
    }

    const data: any = await res.json();
    if (typeof data?.id !== 'string' || data.id === '') {
      throw new ProviderError({
        provider: this.providerName,
        operation: 'createEvent',
        kind: 'UNKNOWN',
        signal: '2xx response carried no event id',
      });
    }

    // `conferenceUrl` is `string | null` precisely so absence can be stated. The old default
    // was "https://meet.google.com/" — the Meet homepage — which resolves to a page that is
    // not the meeting, and is indistinguishable from a working link until someone clicks it.
    const entryPoints: any[] = Array.isArray(data?.conferenceData?.entryPoints)
      ? data.conferenceData.entryPoints
      : [];
    const video = entryPoints.find((ep) => ep?.entryPointType === 'video');
    const conferenceUrl = typeof video?.uri === 'string' && video.uri !== '' ? video.uri : null;

    return { eventId: data.id, conferenceUrl };
  }
}

export const calendarService = new GoogleCalendarService();

/**
 * The old name. Kept as an alias only so a reader grepping for it finds this file and this
 * comment rather than concluding the class was deleted.
 */
export { GoogleCalendarService as CalendarService };
