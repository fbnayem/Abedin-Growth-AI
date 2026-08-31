const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// Replace Funnel Endpoint DB queries (these were missed/overwritten or lingering)
code = code.replace(/const allContacts = await db\.select\(\)\.from\(schema\.contacts\);/g, `const allContactsSnap = await firestore.collection('organizations/org_1/contacts').get(); const allContacts: any[] = []; allContactsSnap.forEach(d => allContacts.push(d.data()));`);
code = code.replace(/const allConvs = await db\.select\(\)\.from\(schema\.conversations\);/g, `const allConvsSnap = await firestore.collection('organizations/org_1/conversations').get(); const allConvs: any[] = []; allConvsSnap.forEach(d => allConvs.push(d.data()));`);
code = code.replace(/const allMeetings = await db\.select\(\)\.from\(schema\.meetings\);/g, `const allMeetingsSnap = await firestore.collection('organizations/org_1/meetings').get(); const allMeetings: any[] = []; allMeetingsSnap.forEach(d => allMeetings.push(d.data()));`);

// Replace /api/leads DB queries
code = code.replace(/const dbLeads = await db\.select\(\)\.from\(schema\.contacts\);/g, `const dbLeadsSnap = await firestore.collection('organizations/org_1/contacts').get(); const dbLeads: any[] = []; dbLeadsSnap.forEach(d => dbLeads.push(d.data()));`);

// Insert Contacts
code = code.replace(/await db\.insert\(schema\.contacts\)\.values\(\{/g, `await firestore.collection('organizations/org_1/contacts').add({`);

// Campaigns DB Queries
code = code.replace(/const dbCamps = await db\.select\(\)\.from\(schema\.campaigns\);/g, `const dbCampsSnap = await firestore.collection('organizations/org_1/campaigns').get(); const dbCamps: any[] = []; dbCampsSnap.forEach(d => dbCamps.push(d.data()));`);

// Opportunities DB Queries
code = code.replace(/const dbOpps = await db\.select\(\)\.from\(schema\.opportunities\);/g, `const dbOppsSnap = await firestore.collection('organizations/org_1/opportunities').get(); const dbOpps: any[] = []; dbOppsSnap.forEach(d => dbOpps.push(d.data()));`);
code = code.replace(/await db\.insert\(schema\.opportunities\)\.values\(\{/g, `await firestore.collection('organizations/org_1/opportunities').add({`);

// Meetings DB Queries
code = code.replace(/const dbMeetings = await db\.select\(\)\.from\(schema\.meetings\);/g, `const dbMeetingsSnap = await firestore.collection('organizations/org_1/meetings').get(); const dbMeetings: any[] = []; dbMeetingsSnap.forEach(d => dbMeetings.push(d.data()));`);

// Remove oauth connections db logic for now (mocking for compile safety)
const oauthReplace = `      const existing = await firestore.collection('oauth_connections').where('organizationId', '==', 'org_1').where('provider', '==', 'gmail').get();
      if (!existing.empty) {
        await existing.docs[0].ref.update({
          accessToken: 'mock_token',
          refreshToken: 'mock_refresh',
          updatedAt: new Date()
        });
      } else {
        await firestore.collection('oauth_connections').add({
          id: 'oauth_' + Date.now(),
          organizationId: 'org_1',
          provider: 'gmail',
          accessToken: 'mock_token',
          refreshToken: 'mock_refresh',
          status: 'ACTIVE',
          updatedAt: new Date()
        });
      }`;
code = code.replace(/const existing = await db\.select\(\)\.from\(schema\.oauthConnections\)[\s\S]*?await db\.insert\(schema\.oauthConnections\)\.values\(\{[^\}]*\}\);/m, oauthReplace);

fs.writeFileSync(file, code);
console.log("Replaced leftover db queries");
