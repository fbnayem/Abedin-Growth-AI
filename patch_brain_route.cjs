const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const route = `
  app.get("/api/company-brain", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection } = require('firebase/firestore');
      const snap = await getDocs(collection(firestore, 'organizations/org_1/company_brain'));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items[0] || {});
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/company-brain", async (req: Request, res: Response) => {
    try {
      const { setDoc, doc } = require('firebase/firestore');
      await setDoc(doc(firestore, 'organizations/org_1/company_brain', 'main'), req.body);
      res.json(req.body);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/dashboard", async (_req: Request, res: Response) => {',
    route + '\n  app.get("/api/dashboard", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
