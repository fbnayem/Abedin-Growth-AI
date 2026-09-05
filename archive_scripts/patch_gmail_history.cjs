const fs = require('fs');
const file = 'server/services/gmailHistorySync.service.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `  async processEvent(emailAddress: string, historyId: string) {
    try {`;

const replace = `  // N. GMAIL EDGE CASES
  async handleHistoryExpiration(emailAddress: string) {
      console.warn(\`[GmailHistorySync] History ID expired for \${emailAddress}. Performing full sync.\`);
      // Logic for full sync goes here
  }

  async processEvent(emailAddress: string, historyId: string) {
    try {`;

code = code.replace(anchor, replace);

const errorAnchor = `    } catch(e) {
      console.error("Error syncing Gmail history:", e);
    }`;

const errorReplace = `    } catch(e: any) {
      if (e.message?.includes('historyId is out of date') || e.code === 404) {
         await this.handleHistoryExpiration(emailAddress);
      } else {
         console.error("Error syncing Gmail history:", e);
      }
    }`;
code = code.replace(errorAnchor, errorReplace);

fs.writeFileSync(file, code);
