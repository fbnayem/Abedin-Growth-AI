const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

if (!server.includes('import { requireAuth }')) {
    server = server.replace('import { globalStore } from "./server/dataStore";', 'import { globalStore } from "./server/dataStore";\nimport { requireAuth } from "./server/middleware/auth";');
    
    // We can mount it right after express.json() but before API routes.
    // However, wait! Webhooks need to bypass requireAuth.
    // Webhooks might use express.raw(). Let's find Stripe and DocuSign routes.
    // DocuSign is currently: app.post("/api/signature/webhook"
    // Stripe is currently: app.post("/api/stripe/webhook" (if it exists)
    
    const mountCode = `
app.use("/api", (req, res, next) => {
  // Bypass auth for webhooks
  if (req.path.includes('/webhook')) {
    return next();
  }
  return requireAuth(req, res, next);
});
`;
    // Find where the API routes begin. Usually after app.use(express.json());
    server = server.replace('app.use(express.json());', 'app.use(express.json());\n' + mountCode);
    
    fs.writeFileSync('server.ts', server);
    console.log("Injected requireAuth middleware");
}
