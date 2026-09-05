const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

// Replace Free/busy mock
const freeBusyLogic = `
         // 4. Check free/busy via Google Calendar API
         const fbRes = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
             method: 'POST',
             headers: { 'Authorization': \`Bearer \${accessToken}\`, 'Content-Type': 'application/json' },
             body: JSON.stringify({
                 timeMin: request.payload.startTime,
                 timeMax: request.payload.endTime,
                 items: [{ id: 'primary' }]
             })
         });
         const fbData = await fbRes.json();
         const hasConflict = fbData.calendars?.primary?.busy?.length > 0;
`;

code = code.replace(
    '     // 4. Check free/busy (Mock)\n     const hasConflict = false;',
    '     // 4. Check free/busy\n     let hasConflict = false;\n     // We will check it inside the real API call block to use the token.'
);

code = code.replace(
    "         if (accessToken === 'mock_token') {\n             return { success: true, providerResult: { eventId: 'sim_evt_' + Date.now() } };\n         }",
    "         if (accessToken === 'mock_token') {\n             return { success: true, providerResult: { eventId: 'sim_evt_' + Date.now() } };\n         }\n" + freeBusyLogic
);

// Replace consent stubs
const consentLogic = `
        // Resolve contact consent and jurisdiction
        let resolvedCountry = 'US';
        let resolvedConsent = true;
        if (request.payload.contactId) {
            const contactSnap = await firestore.collection('organizations/org_1/contacts').doc(request.payload.contactId).get();
            if (contactSnap.exists) {
                const contactData = contactSnap.data() as any;
                resolvedCountry = contactData.country || 'US';
                resolvedConsent = contactData.consentGiven !== false; // default true unless explicit false
            }
        }
        
        const policyResult = await outreachPolicyService.evaluateOutreach({
             country: resolvedCountry,
             campaignType: 'inbound',
             consentGiven: resolvedConsent,
             isB2B: true
        });
`;

code = code.replace(
    /        const policyResult = await outreachPolicyService\.evaluateOutreach\(\{\s*country: 'US', \/\/ Stub\s*campaignType: 'inbound',\s*consentGiven: true, \/\/ Stub\s*isB2B: true\s*\}\);/g,
    consentLogic
);

fs.writeFileSync('server/gateway/actionGateway.ts', code);
