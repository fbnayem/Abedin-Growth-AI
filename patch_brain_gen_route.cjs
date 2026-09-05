const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const genRoute = `
  app.post("/api/company-brain/generate", async (req: Request, res: Response) => {
    try {
      const { generateCompanyBrain } = require('./server/agents/companyBrainAgent');
      const result = await generateCompanyBrain(req.body);
      const { setDoc, doc } = require('firebase/firestore');
      await setDoc(doc(firestore, 'organizations/org_1/company_brain', 'main'), result);
      res.json(result);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/dashboard", async (_req: Request, res: Response) => {',
    genRoute + '\n  app.get("/api/dashboard", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
