const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const replacement = `
  app.get("/api/inbox/circuit-breaker", (_req: Request, res: Response) => {
    // We import circuitBreaker from salesDecisionEngine dynamically or just require it
    // Wait, since we are in server.ts we can import it at the top or inline.
    res.json({
      enabled: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.globalAutonomousSendEnabled,
      reason: require('./server/agents/salesDecisionEngine.ts').circuitBreaker.pausedReason
    });
  });
`;

code = code.replace(
`  app.get("/api/inbox/circuit-breaker", (_req: Request, res: Response) => {
    
  });`,
replacement.trim()
);

fs.writeFileSync('server.ts', code);
console.log("Updated circuit breaker get endpoint");
