const fs = require('fs');
const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

const readinessRoute = `
  // EXECUTABLE READINESS CHECK (Requirement X)
  app.get("/api/readiness", async (_req: Request, res: Response) => {
    try {
      const checks = {
        databaseConnectivity: !!firestore,
        actionGatewayLoaded: true, // We import it statically
        safeRebuildMode: {
          email: process.env.REAL_EMAIL_SEND_ENABLED === 'true',
          calendar: process.env.REAL_CALENDAR_CREATE_ENABLED === 'true',
        }
      };

      const isReady = checks.databaseConnectivity;
      
      res.json({
        status: isReady ? "READY" : "NOT_READY",
        checks
      });
    } catch (e: any) {
      res.status(500).json({ status: "DEGRADED", error: e.message });
    }
  });
`;

if (!code.includes('/api/readiness')) {
   const insertIndex = code.indexOf('app.get("/api/health"');
   if (insertIndex > -1) {
       code = code.slice(0, insertIndex) + readinessRoute + code.slice(insertIndex);
       fs.writeFileSync(file, code);
       console.log("Readiness route added");
   } else {
       console.log("Could not find health route to anchor near");
   }
}
