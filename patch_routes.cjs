const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const missingRoutes = `
  app.get("/api/leads", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection } = require('firebase/firestore');
      const snap = await getDocs(collection(firestore, 'organizations/org_1/contacts'));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      // filter for leads
      res.json(items.filter(i => i.type === 'LEAD' || !i.type));
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/leads", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const id = "lead_" + Date.now();
      const payload = { ...req.body, id, type: 'LEAD', status: 'NEW' };
      await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/inbox", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection } = require('firebase/firestore');
      const snap = await getDocs(collection(firestore, 'organizations/org_1/conversations'));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/knowledge", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection } = require('firebase/firestore');
      const snap = await getDocs(collection(firestore, 'organizations/org_1/knowledge'));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/logs", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection, query, orderBy, limit } = require('firebase/firestore');
      const snap = await getDocs(query(collection(firestore, 'organizations/org_1/ai_logs'), orderBy('timestamp', 'desc'), limit(50)));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.get("/api/pipeline", async (_req: Request, res: Response) => {
    try {
      const { getDocs, collection } = require('firebase/firestore');
      const snap = await getDocs(collection(firestore, 'organizations/org_1/opportunities'));
      const items: any[] = [];
      snap.forEach((d: any) => items.push(d.data()));
      res.json(items);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/dashboard", async (_req: Request, res: Response) => {',
    missingRoutes + '\n  app.get("/api/dashboard", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
