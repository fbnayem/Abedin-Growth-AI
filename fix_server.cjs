const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  'const payload = { ...req.body, id: "kno_" + Date.now(), createdAt: new Date().toISOString(),\n        isABTestingEnabled: !!isABTestingEnabled };',
  'const payload = { ...req.body, id: "kno_" + Date.now(), createdAt: new Date().toISOString() };'
);

fs.writeFileSync('server.ts', code);
