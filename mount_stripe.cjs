const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const importStmt = `import { stripeRouter } from "./server/routes/stripe.routes.ts";\n`;
if (!code.includes('stripeRouter')) {
  code = code.replace('import express', importStmt + 'import express');
  code = code.replace(/app\.use\("\/api\/outbox", outboxRouter\);/g, 'app.use("/api/outbox", outboxRouter);\n  app.use("/api/stripe", stripeRouter);');
  fs.writeFileSync('server.ts', code);
  console.log('Stripe router mounted!');
}
