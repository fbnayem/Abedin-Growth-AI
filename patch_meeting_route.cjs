const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const route = `
  app.post("/api/meetings", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const payload = { ...req.body, id: "meet_" + Date.now(), status: 'SCHEDULED' };
      await addDoc(collection(firestore, 'organizations/org_1/meetings'), payload);
      res.json(payload);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/meetings", async (_req: Request, res: Response) => {',
    route + '\n  app.get("/api/meetings", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
