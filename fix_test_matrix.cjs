const fs = require('fs');
let code = fs.readFileSync('server/agents/salesEngineTestMatrix.ts', 'utf8');

code = code.replace(
    'const auditResult = auditReplyAgainstPlan(',
    'const auditResult = await auditReplyAgainstPlan('
);

fs.writeFileSync('server/agents/salesEngineTestMatrix.ts', code);
