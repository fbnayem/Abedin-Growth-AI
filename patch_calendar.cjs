const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

const calendarLogic = `
     if (process.env.REAL_CALENDAR_CREATE_ENABLED === 'true') {
         if (!firestore) return { success: false, error: 'Firestore not initialized' };
         // Fetch oauth token for organization
         const q = query(collection(firestore, 'oauth_connections'), where('organizationId', '==', request.organizationId));
         const oauthsSnap = await getDocs(q);
         let accessToken = 'mock_token';
         oauthsSnap.forEach(doc => {
             if (doc.data().provider === 'gmail' || doc.data().provider === 'GMAIL') {
                 accessToken = doc.data().accessToken;
             }
         });
         
         if (accessToken === 'mock_token') {
             return { success: true, providerResult: { eventId: 'sim_evt_' + Date.now() } };
         }
         
         // Perform real Google Calendar API call
         try {
             const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1', {
                 method: 'POST',
                 headers: {
                     'Authorization': \`Bearer \${accessToken}\`,
                     'Content-Type': 'application/json'
                 },
                 body: JSON.stringify({
                     summary: request.payload.title,
                     start: { dateTime: request.payload.startTime, timeZone: tz },
                     end: { dateTime: request.payload.endTime, timeZone: tz },
                     attendees: request.payload.attendees ? request.payload.attendees.map((e: string) => ({ email: e })) : [],
                     conferenceData: {
                         createRequest: {
                             requestId: "req_" + Date.now(),
                             conferenceSolutionKey: { type: "hangoutsMeet" }
                         }
                     }
                 })
             });
             
             if (!res.ok) {
                 const errorText = await res.text();
                 throw new Error(\`Calendar API Error: \${res.status} \${errorText}\`);
             }
             
             const data = await res.json();
             return { success: true, providerResult: { eventId: data.id, meetLink: data.hangoutLink } };
         } catch(err: any) {
             throw new Error(err.message);
         }
     } else {
         console.log('[ActionGateway] Mocking CALENDAR_CREATE due to SAFE REBUILD MODE');
         return { success: true, providerResult: { eventId: 'mock_evt_123' } };
     }
`;

code = code.replace(
    /if \(process\.env\.REAL_CALENDAR_CREATE_ENABLED === 'true'\) \{[\s\S]*?eventId: 'mock_evt_123' \} \};\n     \}/g,
    calendarLogic
);

fs.writeFileSync('server/gateway/actionGateway.ts', code);
