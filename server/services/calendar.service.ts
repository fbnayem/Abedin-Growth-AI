import { config } from '../config/environment';

export class CalendarService {
  private accessToken: string | null = null;

  setCredentials(tokens: { access_token: string }) {
    this.accessToken = tokens.access_token;
  }

  // O. CALENDAR EDGE CASES
  async checkFreeBusy(startTime: Date, endTime: Date, timeZone: string, emails: string[]): Promise<boolean> {
     // Implement real check against free/busy API
     return true; 
  }

  async validateBusinessHours(startTime: Date, timeZone: string): Promise<boolean> {
     // Validate against configured business hours
     const hour = startTime.getUTCHours();
     // Simple stub
     return true;
  }

  async createMeeting(params: {
    title: string;
    description?: string;
    startTime: Date;
    endTime: Date;
    attendees: string[];
    timeZone: string;
  }) {
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
