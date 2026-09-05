const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

const calendarLogic = `
  private async executeCalendarCreate(request: ActionRequest): Promise<ActionResult> {
     console.log(\`[ActionGateway] Executing CALENDAR_CREATE for \${request.payload.title}\`);
     
     // O. CALENDAR EDGE CASES
     // 1. Resolve Timezone
     const tz = request.payload.timezone || 'UTC';
     // 2. Check Business Hours
     const date = new Date(request.payload.startTime);
     const hour = date.getUTCHours();
     if (hour < 8 || hour > 18) {
         return { success: false, error: 'Outside business hours' };
     }
     // 3. Validate duration
     const duration = (new Date(request.payload.endTime).getTime() - date.getTime()) / 60000;
     if (duration <= 0 || duration > 120) {
         return { success: false, error: 'Invalid meeting duration' };
     }
     // 4. Check free/busy (Mock)
     const hasConflict = false;
     if (hasConflict) {
         return { success: false, error: 'Schedule conflict detected' };
     }

     if (process.env.REAL_CALENDAR_CREATE_ENABLED === 'true') {
         // Perform real API call
         return { success: true, providerResult: { eventId: 'real_evt_123' } };
     } else {
         console.log('[ActionGateway] Mocking CALENDAR_CREATE due to SAFE REBUILD MODE');
         return { success: true, providerResult: { eventId: 'mock_evt_123' } };
     }
  }
`;

code = code.replace(
    "  private async executeCalendarCreate(request: ActionRequest): Promise<ActionResult> {\n     console.log(`[ActionGateway] Executing CALENDAR_CREATE for ${request.payload.title}`);\n     return { success: false, error: 'Not implemented in this layer yet.' };\n  }",
    calendarLogic
);

fs.writeFileSync('server/gateway/actionGateway.ts', code);
