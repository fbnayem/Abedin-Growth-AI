const fs = require('fs');
const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

const oldBypass = `app.use("/api", (req, res, next) => {
  // Bypass auth for webhooks
  if (req.path.includes('/webhook')) {
    return next();
  }
  return requireAuth(req, res, next);
});`;

const newBypass = `app.use("/api", (req, res, next) => {
  // Bypass auth for webhooks and health/readiness checks
  if (req.path.includes('/webhook') || req.path.startsWith('/readiness') || req.path.startsWith('/health')) {
    return next();
  }
  return requireAuth(req, res, next);
});`;

code = code.replace(oldBypass, newBypass);
fs.writeFileSync(file, code);
