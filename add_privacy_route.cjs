const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const privacyImport = `import { PrivacyService } from './server/services/privacy.service';\n`;
if (!code.includes('PrivacyService')) {
    code = privacyImport + code;
}

const privacyRoute = `
  app.post("/api/privacy/anonymize", async (req: Request, res: Response) => {
    try {
       const privacyService = new PrivacyService();
       await privacyService.anonymizeContact(req.body.contactId);
       res.json({ success: true, message: "Contact anonymized successfully." });
    } catch(e: any) {
       res.status(500).json({ error: e.message });
    }
  });
`;

code = code.replace(
    '  app.get("/api/health", (_req: Request, res: Response) => {',
    privacyRoute + '  app.get("/api/health", (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
