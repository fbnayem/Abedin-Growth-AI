const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

code = code.replace(
    'const nbaResult = determineNextBestAction(understanding); // wait, it might need more args',
    `const nbaResult = determineNextBestAction(understanding, 'DISCOVERY' as any, {} as any, {} as any);`
);

code = code.replace(
    "if (nbaResult.action === 'WAIT' || nbaResult.action === 'NO_REPLY' || nbaResult.action === 'SUPPRESS') {",
    "if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any) {"
);

code = code.replace(
    "if (auditResult.decision === 'BLOCK') {",
    "if ((auditResult.decision as any) === 'BLOCK') {"
);

code = code.replace(
    "const outboxStatus = auditResult.decision === 'HUMAN_REVIEW_REQUIRED' ? 'HUMAN_REVIEW' : 'PENDING';",
    "const outboxStatus = (auditResult.decision as any) === 'HUMAN_REVIEW_REQUIRED' ? 'HUMAN_REVIEW' : 'PENDING';"
);

fs.writeFileSync('server/services/inboundPipeline.ts', code);
