const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const growthRoute = `
  app.post("/api/growth-command", async (req: Request, res: Response) => {
    try {
      const { processGrowthCommand } = require('./server/agents/growthCommandAgent');
      const result = await processGrowthCommand(req.body.command);
      res.json(result);
    } catch(e: any) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
`;

code = code.replace(
    '  // 12. AI Growth Command & Agent Chat',
    growthRoute + '\n  // 12. AI Growth Command & Agent Chat'
);

fs.writeFileSync('server.ts', code);
