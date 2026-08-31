const fs = require('fs');

let service = fs.readFileSync('server/services/gmail.service.ts', 'utf8');

const fetchMethods = `
  async getHistory(historyId: string, emailAddress: string): Promise<any[]> {
    if (!this.accessToken) throw new Error("Credentials not set");
    
    // We get the history
    const res = await fetch(\`https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=\${historyId}\`, {
      headers: { 'Authorization': \`Bearer \${this.accessToken}\` }
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
    
    const res = await fetch(\`https://gmail.googleapis.com/gmail/v1/users/me/messages/\${messageId}?format=full\`, {
      headers: { 'Authorization': \`Bearer \${this.accessToken}\` }
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
`;

if (!service.includes('getMessage(')) {
    service = service.replace('async sendEmail', fetchMethods + '\n  async sendEmail');
    fs.writeFileSync('server/services/gmail.service.ts', service);
    console.log("Added fetch methods to GmailService");
}
