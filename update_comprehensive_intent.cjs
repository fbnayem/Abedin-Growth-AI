const fs = require('fs');
let code = fs.readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');
code = code.replace(
    '  | "START_ONBOARDING"',
    '  | "START_ONBOARDING"\n  | "SUPPRESS"'
);
fs.writeFileSync('server/agents/salesDecisionEngine.ts', code);
