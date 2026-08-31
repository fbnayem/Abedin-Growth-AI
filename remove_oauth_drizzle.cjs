const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// Use a more robust regex or string replacement for the OAuth section
const startIdx = code.indexOf('const existing = await db.select().from(schema.oauthConnections)');
if (startIdx > -1) {
    const endStr = 'await db.insert(schema.oauthConnections).values({';
    const endIdx = code.indexOf(endStr, startIdx);
    
    if (endIdx > -1) {
        // Find the closing bracket of the insert
        const closeIdx = code.indexOf('});', endIdx) + 3;
        
        const toReplace = code.substring(startIdx, closeIdx);
        
        const replacement = `const existing = await firestore.collection('oauth_connections').where('organizationId', '==', 'org_1').where('provider', '==', 'gmail').get();
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
        
        code = code.replace(toReplace, replacement);
        fs.writeFileSync(file, code);
        console.log("OAuth queries replaced");
    }
}
