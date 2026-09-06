import { apiFetch } from '../lib/apiFetch';
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

// P0.1 — 'gmail.send' was removed from this list deliberately. The browser must not hold a
// credential that can deliver mail to a third party: all sending goes through the server so it
// passes the ActionGateway, outreachPolicy, the outbox and the circuit breaker. Read-side scopes
// remain so the inbox and label features keep working. Do not re-add gmail.send here — if the
// browser needs to send, that is a signal the server path is missing something.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
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
    // P0.1 — The OAuth access token is NEVER restored from localStorage, and never written
    // there (see notify()). It previously persisted under 'abedin_workspace_gmail_auth',
    // which meant any script running in this origin could read a live Google credential —
    // a far worse outcome than a stolen session cookie, because it is not invalidated by
    // logging out. With no HTML sanitizer and no CSP in this app (see S35), that is a
    // realistic path, so the token now lives in memory only and dies with the tab.
    //
    // Only non-secret display state is restored, so the UI can still show which account was
    // connected. isConnected stays false until the user re-authorizes, which is honest:
    // without a token in memory there is genuinely no usable Gmail session.
    try {
      const cached = localStorage.getItem('abedin_workspace_gmail_display');
      if (cached) {
        const parsed = JSON.parse(cached);
        this.accountEmail = parsed.accountEmail || DEFAULT_ACCOUNT;
        this.labelId = parsed.labelId || null;
      }
    } catch (e) {
      console.warn('Could not restore cached Gmail display state:', e);
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
    // P0.1 — accessToken and expiresAt are deliberately NOT persisted. Writing a live
    // gmail credential to localStorage put it within reach of any script in this origin.
    // Only non-secret display state is stored.
    try {
      localStorage.setItem('abedin_workspace_gmail_display', JSON.stringify({
        accountEmail: this.accountEmail,
        labelId: this.labelId,
      }));
      // Remove any credential written by a previous build.
      localStorage.removeItem('abedin_workspace_gmail_auth');
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
    localStorage.removeItem('abedin_workspace_gmail_display');
    localStorage.removeItem('abedin_workspace_gmail_auth'); // legacy key from before P0.1
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
    const res = await apiFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
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
    const createRes = await apiFetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
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
  // P0.1 — sendEmail() was REMOVED from this service, deliberately and permanently.
  //
  // It performed a real Gmail REST send from the browser, bypassing the ActionGateway,
  // outreachPolicy, the outbox, the circuit breaker and every REAL_* flag. It was the only
  // code path in the product that could put a message in a third party's inbox with no
  // policy applied, and its single call site (InboxView.handleSend) also fell through to
  // the server dispatch unconditionally, producing a guaranteed double-send.
  //
  // The method is deleted rather than left unused so that any attempt to reintroduce
  // browser-side sending fails at COMPILE time rather than silently working. The
  // gmail.send OAuth scope has been dropped from SCOPES above for the same reason.
  //
  // Sending belongs on the server, behind the gateway. See docs/production/addendum-status.md P0.1.

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

      const listRes = await apiFetch(url, {
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
          const mRes = await apiFetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`, {
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
