const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const batchRoutes = `
  app.post("/api/leads/batch-generate", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const { count = 3, location = 'UK', industry = 'Dental' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "lead_" + Date.now() + "_" + i,
          type: "LEAD",
          name: "Generated Lead " + (i+1),
          title: "Decision Maker",
          companyName: \`\${location} \${industry} Clinic \${i+1}\`,
          primaryEmail: \`lead\${i}@example.com\`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/investors/batch-generate", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const { count = 3, location = 'Global', industry = 'AI' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "inv_" + Date.now() + "_" + i,
          type: "INVESTOR",
          name: "Generated Investor " + (i+1),
          title: "Partner",
          companyName: \`\${location} \${industry} Ventures \${i+1}\`,
          primaryEmail: \`investor\${i}@example.com\`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });

  app.post("/api/partners/batch-generate", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const { count = 3, location = 'Global', industry = 'Tech' } = req.body;
      const results: any[] = [];
      for(let i=0; i<count; i++) {
        const payload = {
          id: "part_" + Date.now() + "_" + i,
          type: "PARTNER",
          name: "Generated Partner " + (i+1),
          title: "Director",
          companyName: \`\${location} \${industry} Corp \${i+1}\`,
          primaryEmail: \`partner\${i}@example.com\`,
          status: "DISCOVERED",
          aiScore: Math.floor(Math.random() * 20) + 70,
          createdAt: new Date().toISOString()
        };
        await addDoc(collection(firestore, 'organizations/org_1/contacts'), payload);
        results.push(payload);
      }
      res.json(results);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/dashboard", async (_req: Request, res: Response) => {',
    batchRoutes + '\n  app.get("/api/dashboard", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
