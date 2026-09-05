const fs = require('fs');
let code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');
code = code.replace(
    '| "UNRESOLVED_NEW"',
    '| "UNRESOLVED_NEW" | "NEW_CONTACT"'
);
fs.writeFileSync('server/services/identityResolver.service.ts', code);
