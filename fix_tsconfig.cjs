const fs = require('fs');
let code = fs.readFileSync('tsconfig.json', 'utf8');
const p = JSON.parse(code);
p.exclude = ["scripts", "dist", "node_modules"];
fs.writeFileSync('tsconfig.json', JSON.stringify(p, null, 2));
