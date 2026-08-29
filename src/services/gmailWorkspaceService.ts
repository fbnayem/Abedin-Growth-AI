/**
 * Google Workspace Gmail Integration Service
 * Account: info@abedintech.com
 * Label: "Abedin Growth AI"
 * 
 * Supports:
 * - Live Google OAuth2 Token Client via Google Identity Services
 * - Label creation & management ("Abedin Growth AI")
 * - Fetching real threads / incoming replies from info@abedintech.com
 * - Sending outbound emails and sequences directly via Gmail REST API
 * - Applying the "Abedin Growth AI" label to outbound and inbound messages
 */

export interface GmailTokenState {
  accessToken: string | null;
  expiresAt: number | null;
  accountEmail: string;
  labelId: string | null;
  isConnected: boolean;
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
].join(' ');

const TARGET_LABEL_NAME = 'Abedin Growth AI';
const DEFAULT_ACCOUNT = 'info@abedintech.com';

class GmailWorkspaceService {
  private tokenClient: any = null;
  private accessToken: string | null = null;
  private expiresAt: number | null = null;
  private labelId: string | null = null;
  private accountEmail: string = DEFAULT_ACCOUNT;
  private listeners: ((state: GmailTokenState) => void)[] = [];

  constructor() {
    // Attempt to load cached session state if available in sessionStorage/localStorage
    try {
      const cached = localStorage.getItem('abedin_workspace_gmail_auth');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed.expiresAt && parsed.expiresAt > Date.now()) {
          this.accessToken = parsed.accessToken;
          this.expiresAt = parsed.expiresAt;
          this.accountEmail = parsed.accountEmail || DEFAULT_ACCOUNT;
          this.labelId = parsed.labelId || null;
        }
      }
    } catch (e) {
      console.warn('Could not restore cached Gmail token:', e);
    }
  }

  public subscribe(listener: (state: GmailTokenState) => void) {
    this.listeners.push(listener);
    listener(this.getState());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify() {
    const state = this.getState();
    this.listeners.forEach((l) => l(state));
    try {
      localStorage.setItem('abedin_workspace_gmail_auth', JSON.stringify({
        accessToken: this.accessToken,
        expiresAt: this.expiresAt,
        accountEmail: this.accountEmail,
        labelId: this.labelId,
      }));
    } catch (e) {
      // Ignore storage errors
    }
  }

  public getState(): GmailTokenState {
    const isTokenValid = !!(this.accessToken && this.expiresAt && this.expiresAt > Date.now());
    return {
      accessToken: isTokenValid ? this.accessToken : null,
      expiresAt: this.expiresAt,
      accountEmail: this.accountEmail,
      labelId: this.labelId,
      isConnected: isTokenValid,
    };
  }

  /**
   * Request user OAuth authorization using Google Identity Services (GSI)
   */
  public async requestAuthorization(hintEmail: string = DEFAULT_ACCOUNT): Promise<string> {
    return new Promise((resolve, reject) => {
      // Check if google accounts client is loaded
      if (typeof window === 'undefined' || !(window as any).google?.accounts?.oauth2) {
        // Retry after short delay in case script is still loading
        setTimeout(() => {
          if (typeof window === 'undefined' || !(window as any).google?.accounts?.oauth2) {
            reject(new Error('Google Identity Services client is not available yet. Please refresh the page.'));
            return;
          }
          this.initTokenFlow(hintEmail, resolve, reject);
        }, 1000);
        return;
      }

      this.initTokenFlow(hintEmail, resolve, reject);
    });
  }

  private initTokenFlow(hintEmail: string, resolve: (token: string) => void, reject: (err: any) => void) {
    try {
      const google = (window as any).google;
      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: '717386608298-gen-lang-client.apps.googleusercontent.com', // Provisioned OAuth client
        scope: SCOPES,
        hint: hintEmail,
        callback: async (response: any) => {
          if (response.error) {
            console.error('Google OAuth token error:', response);
            reject(response);
            return;
          }

          this.accessToken = response.access_token;
          // Default expiry 3500 seconds (approx 1 hour)
          const expiresIn = Number(response.expires_in) || 3599;
          this.expiresAt = Date.now() + (expiresIn * 1000);
          this.accountEmail = hintEmail;

          // Ensure "Abedin Growth AI" label exists
          try {
            await this.ensureAbedinGrowthLabel();
          } catch (lblErr) {
            console.warn('Could not setup label:', lblErr);
          }

          this.notify();
          resolve(response.access_token);
        },
      });

      this.tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err) {
      console.error('Failed to initialize token client:', err);
      reject(err);
    }
  }

  /**
   * Disconnects current workspace session
   */
  public disconnect() {
    this.accessToken = null;
    this.expiresAt = null;
    this.labelId = null;
    localStorage.removeItem('abedin_workspace_gmail_auth');
    this.notify();
  }

  /**
   * Ensures the label "Abedin Growth AI" exists in the user's Gmail box, or creates it.
   */
  public async ensureAbedinGrowthLabel(): Promise<string> {
    if (!this.accessToken) {
      throw new Error('Not authenticated with Gmail');
    }

    // 1. List labels
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to list Gmail labels: ${res.statusText}`);
    }

    const data = await res.json();
    const existing = (data.labels || []).find(
      (l: any) => l.name?.toLowerCase() === TARGET_LABEL_NAME.toLowerCase()
    );

    if (existing) {
      this.labelId = existing.id;
      this.notify();
      return existing.id;
    }

    // 2. Create label if not found
    const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: TARGET_LABEL_NAME,
        labelListVisibility: 'labelShow',
        messageListVisibility: 'show',
        color: {
          textColor: '#ffffff',
          backgroundColor: '#4986e7', // Distinctive Blue matching brand
        },
      }),
    });

    if (!createRes.ok) {
      throw new Error(`Failed to create Gmail label: ${createRes.statusText}`);
    }

    const newLabel = await createRes.json();
    this.labelId = newLabel.id;
    this.notify();
    return newLabel.id;
  }

  /**
   * Helper to format RFC 2822 email string and convert to url-safe base64
   */
  private createRawEmail({
    to,
    from,
    subject,
    bodyText,
    threadId,
    inReplyTo,
    references,
  }: {
    to: string;
    from: string;
    subject: string;
    bodyText: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  }): string {
    const utf8Subject = `=?utf-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
    const messageParts = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${utf8Subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
    ];

    if (inReplyTo) {
      messageParts.push(`In-Reply-To: ${inReplyTo}`);
    }
    if (references) {
      messageParts.push(`References: ${references}`);
    }

    messageParts.push('', bodyText);
    const email = messageParts.join('\r\n');

    // Encode to base64url
    return btoa(unescape(encodeURIComponent(email)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  /**
   * Sends an email directly through Google Workspace (info@abedintech.com)
   * and attaches the "Abedin Growth AI" label to the resulting message.
   */
  public async sendEmail({
    to,
    subject,
    bodyText,
    threadId,
  }: {
    to: string;
    subject: string;
    bodyText: string;
    threadId?: string;
  }): Promise<{ messageId: string; threadId: string; labelName: string }> {
    if (!this.accessToken) {
      throw new Error('Gmail token missing. Please connect your Workspace account.');
    }

    const raw = this.createRawEmail({
      to,
      from: `Nayem Abedin <${this.accountEmail}>`,
      subject,
      bodyText,
      threadId,
    });

    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw,
        threadId: threadId || undefined,
      }),
    });

    if (!sendRes.ok) {
      const errBody = await sendRes.text();
      throw new Error(`Gmail API error (${sendRes.status}): ${errBody}`);
    }

    const sentMessage = await sendRes.json();

    // Attach "Abedin Growth AI" label to the message
    if (this.labelId && sentMessage.id) {
      try {
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${sentMessage.id}/modify`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            addLabelIds: [this.labelId],
          }),
        });
      } catch (lblErr) {
        console.warn('Could not apply label to sent message:', lblErr);
      }
    }

    return {
      messageId: sentMessage.id,
      threadId: sentMessage.threadId,
      labelName: TARGET_LABEL_NAME,
    };
  }

  /**
   * Fetches latest replies and messages labeled with "Abedin Growth AI"
   */
  public async fetchAbedinGrowthMessages(maxResults = 20): Promise<any[]> {
    if (!this.accessToken) {
      return [];
    }

    try {
      // If labelId is not set, ensure it
      if (!this.labelId) {
        await this.ensureAbedinGrowthLabel();
      }

      const query = `label:"${TARGET_LABEL_NAME}" OR to:${this.accountEmail}`;
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`;

      const listRes = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      });

      if (!listRes.ok) return [];

      const listData = await listRes.json();
      if (!listData.messages || listData.messages.length === 0) return [];

      // Fetch message details in batch
      const detailedMessages = await Promise.all(
        listData.messages.slice(0, 10).map(async (msg: { id: string }) => {
          const mRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          });
          if (!mRes.ok) return null;
          return mRes.json();
        })
      );

      return detailedMessages.filter(Boolean);
    } catch (e) {
      console.error('Error fetching Workspace messages:', e);
      return [];
    }
  }
}

export const workspaceGmailService = new GmailWorkspaceService();
