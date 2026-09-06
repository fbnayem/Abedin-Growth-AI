import { config } from '../config/environment';
import {
  DEFAULT_BUSINESS_HOURS,
  assertTimeZone,
  isWithinBusinessHours,
  type BusinessHours,
} from '../../shared/domain/time';

export class CalendarService {
  private accessToken: string | null = null;

  setCredentials(tokens: { access_token: string }) {
    this.accessToken = tokens.access_token;
  }

  // O. CALENDAR EDGE CASES
  //
  // Still unimplemented, and now it says so instead of returning `true`. `true` from a
  // free/busy check means "the slot is free" — a claim this code has never been in a
  // position to make. Callers must treat UNKNOWN as unknown (§14) rather than as free.
  async checkFreeBusy(
    _startTime: Date,
    _endTime: Date,
    timeZone: string,
    _emails: string[]
  ): Promise<{ status: 'UNKNOWN'; reason: string }> {
    assertTimeZone(timeZone);
    return {
      status: 'UNKNOWN',
      reason: 'Free/busy is not wired to a provider; availability has not been checked.',
    };
  }

  /**
   * P1.9 — this read `startTime.getUTCHours()` into an unused variable and returned `true`.
   * A validator that returns true for every input is worse than no validator: every caller
   * reads it as a check that passed. It now answers with the verdict AND the local time it
   * judged, so a refusal can be explained to the person who chose the slot.
   */
  validateBusinessHours(
    startTime: Date,
    timeZone: string,
    hours: BusinessHours = DEFAULT_BUSINESS_HOURS
  ): { valid: boolean; reason: string | null; localTime: string } {
    assertTimeZone(timeZone);
    const verdict = isWithinBusinessHours(startTime, hours);
    return {
      valid: verdict.within,
      reason: verdict.within === true ? null : verdict.reason,
      localTime: verdict.localTime,
    };
  }

  async createMeeting(params: {
    title: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    attendees: string[];
    timeZone: string;
  }) {
    assertTimeZone(params.timeZone);

    if (config.demoMode) {
      console.log("[DEMO MODE] Simulating Calendar meeting creation.");
      return {
        eventId: `sim_event_${Date.now()}`,
        conferenceId: `sim_conf_${Date.now()}`,
        conferenceUrl: `https://meet.google.com/sim-demo-url`,
      };
    }

    if (!this.accessToken) {
      throw new Error("Calendar credentials not configured");
    }

    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        summary: params.title,
        description: params.description,
        start: { dateTime: params.startTime.toISOString(), timeZone: params.timeZone },
        end: { dateTime: params.endTime.toISOString(), timeZone: params.timeZone },
        attendees: params.attendees.map(email => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: `meet_${Date.now()}`,
            conferenceSolutionKey: { type: "hangoutsMeet" }
          }
        }
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Calendar API Error:", errorText);
      throw new Error(`Failed to create calendar event: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    let conferenceUrl = "https://meet.google.com/";
    let conferenceId = "pending";
    
    if (data.conferenceData && data.conferenceData.entryPoints) {
      const videoEntry = data.conferenceData.entryPoints.find((ep: any) => ep.entryPointType === 'video');
      if (videoEntry) {
        conferenceUrl = videoEntry.uri;
        conferenceId = data.conferenceData.conferenceId;
      }
    }

    return {
      eventId: data.id,
      conferenceId: conferenceId,
      conferenceUrl: conferenceUrl,
    };
  }
}

export const calendarService = new CalendarService();
