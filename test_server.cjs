const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// I might have duplicate app.get("/api/campaigns") routes now. Let's fix that.
// Remove the old one.
const oldCampaignsRegex = /app\.get\("\/api\/campaigns", async \(_req: Request, res: Response\) => \{[\s\S]*?res\.json\(mapped\);\n    \} catch\(e\) \{ console\.error\(e\); res\.status\(500\)\.json\(\{error: e\.message\}\); \}\n  \}\);/g;

code = code.replace(oldCampaignsRegex, '');

fs.writeFileSync('server.ts', code);
