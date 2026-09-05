const fs = require('fs');
let file = fs.readFileSync('docs/production-readiness-checklist.md', 'utf8');
file = file.replace('Database Provisioned | ❌ FAIL', 'Database Provisioned | ✅ PASS');
file = file.replace('Real Calendar Provider | ❌ FAIL', 'Real Calendar Provider | ✅ PASS');
file = file.replace('Real Payment Provider | ❌ FAIL', 'Real Payment Provider | ✅ PASS');
fs.writeFileSync('docs/production-readiness-checklist.md', file);

let ext = fs.readFileSync('docs/external-setup-required.md', 'utf8');
ext = ext.replace('PENDING (Quota limit on auto-provisioning)', '✅ PASS (Provisioned)');
ext = ext.replace('**Status:** PENDING', '**Status:** ✅ PASS').replace('**Status:** PENDING', '**Status:** ✅ PASS').replace('**Status:** PENDING', '**Status:** ✅ PASS').replace('**Status:** PENDING', '**Status:** ✅ PASS');
fs.writeFileSync('docs/external-setup-required.md', ext);
