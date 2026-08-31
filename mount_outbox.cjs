const fs = require('fs');
let file = fs.readFileSync('server.ts', 'utf8');

if (file.includes('app.get("/api/outbox"')) {
  // Remove the old app.get("/api/outbox") block
  const oldBlock = `  app.get("/api/outbox", (_req: Request, res: Response) => {
    res.json(globalStore.outboxLogs);
  });`;
  
  if (file.includes(oldBlock)) {
    file = file.replace(oldBlock, '');
  }
}

if (!file.includes('outboxRouter')) {
  file = file.replace('import { stripeRouter } from "./server/routes/stripe.routes";', 'import { stripeRouter } from "./server/routes/stripe.routes";\nimport { outboxRouter } from "./server/routes/outbox.routes";');
  file = file.replace('app.use("/api/stripe", stripeRouter);', 'app.use("/api/stripe", stripeRouter);\n  app.use("/api/outbox", outboxRouter);');
  fs.writeFileSync('server.ts', file);
  console.log("Mounted outbox router");
}
