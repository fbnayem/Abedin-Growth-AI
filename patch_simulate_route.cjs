const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const simulateRoute = `
  app.post("/api/pitch-battle/simulate", async (req: Request, res: Response) => {
    try {
      const { simulatePitchBattle } = require('./server/agents/pitchBattleAgent');
      const result = await simulatePitchBattle(req.body);
      res.json(result);
    } catch(e: any) { res.status(500).json({error: e.message}); }
  });
`;

code = code.replace(
    '  app.get("/api/dashboard", async (_req: Request, res: Response) => {',
    simulateRoute + '\n  app.get("/api/dashboard", async (_req: Request, res: Response) => {'
);

fs.writeFileSync('server.ts', code);
