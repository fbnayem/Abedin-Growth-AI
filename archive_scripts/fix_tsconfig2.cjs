const fs = require('fs');
let code = fs.readFileSync('tsconfig.json', 'utf8');
const p = JSON.parse(code);
if (p.compilerOptions && p.compilerOptions.exclude) {
  delete p.compilerOptions.exclude;
}
fs.writeFileSync('tsconfig.json', JSON.stringify(p, null, 2));
