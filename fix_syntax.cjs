const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `        await firestore.collection('oauth_connections').add({
          id: 'oauth_' + Date.now(),
          organizationId: 'org_1',
          provider: 'gmail',
          accessToken: 'mock_token',
          refreshToken: 'mock_refresh',
          status: 'ACTIVE',
          updatedAt: new Date()
        });
      }
      }
      res.json({ success: true });`;

const replace = `        await firestore.collection('oauth_connections').add({
          id: 'oauth_' + Date.now(),
          organizationId: 'org_1',
          provider: 'gmail',
          accessToken: 'mock_token',
          refreshToken: 'mock_refresh',
          status: 'ACTIVE',
          updatedAt: new Date()
        });
      }
      res.json({ success: true });`;

code = code.replace(anchor, replace);
fs.writeFileSync(file, code);
console.log("Syntax fixed");
