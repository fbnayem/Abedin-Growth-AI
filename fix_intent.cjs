const fs = require('fs');
let code = fs.readFileSync('shared/domain/models.ts', 'utf8');
code = code.replace(
    '  | "START_ONBOARDING";',
    '  | "START_ONBOARDING"\n  | "SUPPRESS";'
);
fs.writeFileSync('shared/domain/models.ts', code);
