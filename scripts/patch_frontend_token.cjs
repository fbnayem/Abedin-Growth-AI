const fs = require('fs');

let service = fs.readFileSync('src/services/gmailWorkspaceService.ts', 'utf8');

const syncCode = `
      // Sync to backend
      fetch("/api/integrations/gmail/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken: response.access_token,
          expiresIn: response.expires_in,
          accountEmail: hintEmail
        })
      }).catch(e => console.error("Failed to sync Gmail token to backend", e));
`;

if (!service.includes('/api/integrations/gmail/token')) {
    service = service.replace('this.notifyStateChange();', 'this.notifyStateChange();\n' + syncCode);
    fs.writeFileSync('src/services/gmailWorkspaceService.ts', service);
    console.log("Patched gmailWorkspaceService to sync token");
}
