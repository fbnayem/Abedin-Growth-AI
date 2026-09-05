const fs = require('fs');
let pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts.readiness = "tsx scripts/readiness.ts";
pkg.scripts["test:adversarial"] = "tsx -e \"import('./server/tests/adversarial.test.ts').then(m => m.runRedTeamTests())\"";
pkg.scripts["security:audit"] = "npm audit";
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
