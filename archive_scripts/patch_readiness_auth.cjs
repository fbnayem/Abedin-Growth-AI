const fs = require('fs');
const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace("if (req.path.startsWith(\"/api/health\") || req.path === \"/api/mock/send\") {",
                    "if (req.path.startsWith(\"/api/health\") || req.path.startsWith(\"/api/readiness\") || req.path === \"/api/mock/send\") {");

fs.writeFileSync(file, code);
