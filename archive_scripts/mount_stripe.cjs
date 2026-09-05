const fs = require('fs');
let file = fs.readFileSync('server.ts', 'utf8');
if (!file.includes('stripeRouter')) {
  file = file.replace('import { requireAuth } from "./server/middleware/auth";', 'import { requireAuth } from "./server/middleware/auth";\nimport { stripeRouter } from "./server/routes/stripe.routes";');
  file = file.replace('app.get("/api/health"', 'app.use("/api/stripe", stripeRouter);\n\n  app.get("/api/health"');
  fs.writeFileSync('server.ts', file);
  console.log("Mounted stripe router");
}
