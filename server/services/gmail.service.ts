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

  
  async getHistory(historyId: string, emailAddress: string): Promise<any[]> {
    if (!this.accessToken) throw new Error("Credentials not set");
    
    // We get the history
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${historyId}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    
    if (!res.ok) {
       console.error("Failed to fetch Gmail history", await res.text());
       return [];
    }
    const data = await res.json();
    return data.history || [];
  }

  async getMessage(messageId: string): Promise<GmailMessage | null> {
    if (!this.accessToken) throw new Error("Credentials not set");
    
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` }
    });
    
    if (!res.ok) {
       console.error("Failed to fetch Gmail message", await res.text());
       return null;
    }
    const data = await res.json();
    return this.parseMessage(data);
  }

  private parseMessage(data: any): GmailMessage {
    const headers = data.payload.headers || [];
    const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
    
    // Simplistic MIME parser for demonstration
    let textBody = '';
    let htmlBody = '';
    
    const parseParts = (parts: any[]) => {
      for (const part of parts) {
        if (part.mimeType === 'text/plain' && part.body.data) {
          textBody += Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (part.mimeType === 'text/html' && part.body.data) {
          htmlBody += Buffer.from(part.body.data, 'base64').toString('utf8');
        } else if (part.parts) {
          parseParts(part.parts);
        }
      }
    };
    
    if (data.payload.parts) {
      parseParts(data.payload.parts);
    } else if (data.payload.body?.data) {
       if (data.payload.mimeType === 'text/html') {
          htmlBody = Buffer.from(data.payload.body.data, 'base64').toString('utf8');
       } else {
          textBody = Buffer.from(data.payload.body.data, 'base64').toString('utf8');
       }
    }

    return {
      id: data.id,
      threadId: data.threadId,
      snippet: data.snippet,
      payload: data.payload,
      subject: getHeader('subject'),
      from: getHeader('from'),
      to: getHeader('to'),
      date: getHeader('date'),
      textBody,
      htmlBody,
      inReplyTo: getHeader('in-reply-to'),
      references: getHeader('references'),
    };
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
