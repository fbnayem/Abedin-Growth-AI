const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

code = code.replace(
    '  error?: string;',
    '  error?: string;\n  isAmbiguousResult?: boolean;'
);

code = code.replace(
    'return { success: false, error: e.message };',
    `if (e.message?.includes('timeout') || e.message?.includes('ECONNRESET')) {
        return { success: false, error: e.message, isAmbiguousResult: true };
      }
      return { success: false, error: e.message };`
);

fs.writeFileSync('server/gateway/actionGateway.ts', code);

code = fs.readFileSync('server/workers/outbox.worker.ts', 'utf8');
code = code.replace(
    '             if (result.blockedReason) {',
    `             if (result.isAmbiguousResult) {
                // Rule E: AMBIGUOUS_PROVIDER_RESULT
                console.warn(\`Ambiguous provider result for job \${job.id}. Setting status to AMBIGUOUS_PROVIDER_RESULT to prevent double sending before reconciliation.\`);
                await outboxService.markFailed(job.id, "AMBIGUOUS_PROVIDER_RESULT");
             } else if (result.blockedReason) {`
);

fs.writeFileSync('server/workers/outbox.worker.ts', code);
