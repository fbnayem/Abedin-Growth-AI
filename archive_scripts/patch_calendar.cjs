const fs = require('fs');
const file = 'server/services/calendar.service.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `  async createMeeting(params: {`;
const replace = `  // O. CALENDAR EDGE CASES
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

  async createMeeting(params: {`;

code = code.replace(anchor, replace);
fs.writeFileSync(file, code);
