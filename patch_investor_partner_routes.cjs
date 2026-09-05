const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const filterLogicInvestor = `
  app.get("/api/investors", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection, query, where } = require('firebase/firestore');
      const snap = await getDocs(query(collection(firestore, 'organizations/org_1/contacts'), where('type', '==', 'INVESTOR')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/investors", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const id = "inv_" + Date.now();
      const payload = { ...req.body, id, type: 'INVESTOR', status: 'DISCOVERED' };
      await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

const filterLogicPartner = `
  app.get("/api/partners", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection, query, where } = require('firebase/firestore');
      const snap = await getDocs(query(collection(firestore, 'organizations/org_1/contacts'), where('type', '==', 'PARTNER')));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/partners", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const id = "part_" + Date.now();
      const payload = { ...req.body, id, type: 'PARTNER', status: 'DISCOVERED' };
      await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(/app\.get\("\/api\/investors"[\s\S]*?app\.post\("\/api\/investors"[\s\S]*?res\.status\(500\)\.json\(\{error: e\.message\}\);\n    \}\n  \}\);/m, filterLogicInvestor);
code = code.replace(/app\.get\("\/api\/partners"[\s\S]*?app\.post\("\/api\/partners"[\s\S]*?res\.status\(500\)\.json\(\{error: e\.message\}\);\n    \}\n  \}\);/m, filterLogicPartner);

fs.writeFileSync('server.ts', code);
