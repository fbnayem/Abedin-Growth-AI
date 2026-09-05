const fs = require('fs');
const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace("const publicRoutes = ['/api/health', '/api/stripe/webhook', '/api/mock/send'];",
                    "const publicRoutes = ['/api/health', '/api/readiness', '/api/stripe/webhook', '/api/mock/send'];");

fs.writeFileSync(file, code);
