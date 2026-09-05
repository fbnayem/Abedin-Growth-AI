const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const pipelinePostLogic = `
  app.post("/api/pipeline", async (req: Request, res: Response) => {
    try {
      const { addDoc, collection } = require('firebase/firestore');
      const newId = \`opp_\${Date.now()}\`;
      const payload = { ...req.body, id: newId, value: req.body.estimatedValue || req.body.value || 0 };
      await addDoc(collection(firestore, 'organizations/org_1/opportunities'), payload);
      res.json(payload);
    } catch(e: any) {
      console.error(e);
      res.status(500).json({error: e.message});
    }
  });
`;

code = code.replace(/app\.post\("\/api\/pipeline"[\s\S]*?res\.status\(500\)\.json\(\{error: e\.message\}\);\n    \}\n  \}\);/m, pipelinePostLogic);

fs.writeFileSync('server.ts', code);
