import { config } from '../config/environment';

export interface SendEmailOptions {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  snippet: string;
  payload: any;
  // mapped fields
  subject: string;
  from: string;
  to: string;
  date: string;
  textBody: string;
  htmlBody: string;
  inReplyTo?: string;
  references?: string;
}

export class GmailService {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  constructor() {
    // initialize from DB or secure vault
  }

  setCredentials(tokens: { access_token: string; refresh_token?: string }) {
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token;
    }
  }

  async sendEmail(opts: SendEmailOptions): Promise<{ messageId: string, threadId: string }> {
    if (config.demoMode) {
      console.log(`[DEMO MODE] Simulating Gmail send to ${opts.to}`);
      return {
        messageId: `sim_${Date.now()}_msg`,
        threadId: opts.threadId || `sim_${Date.now()}_thread`
      };
    }
    
    if (!this.accessToken) {
      throw new Error("Gmail credentials not configured");
    }

    // Construct MIME message
    const messageParts = [
      `To: ${opts.to}`,
      `Subject: ${opts.subject}`,
      `Content-Type: text/html; charset=utf-8`,
    ];
    if (opts.inReplyTo) messageParts.push(`In-Reply-To: ${opts.inReplyTo}`);
    if (opts.references) messageParts.push(`References: ${opts.references}`);
    messageParts.push('', opts.bodyHtml || opts.bodyText || '');

    const rawMessage = Buffer.from(messageParts.join('\r\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: rawMessage,
        threadId: opts.threadId
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("Gmail API Error:", errorText);
      throw new Error(`Failed to send email via Gmail API: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return {
      messageId: data.id,
      threadId: data.threadId
    };
  }
}

export const gmailService = new GmailService();
