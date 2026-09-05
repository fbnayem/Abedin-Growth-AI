const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

const importStr = "import { MetricsService } from './metrics.service';\n";
if (!code.includes('MetricsService')) {
    code = importStr + code;
}

code = code.replace(
    'try {',
    'try {\n      const startTime = Date.now();'
);

code = code.replace(
    'console.log(`--- Pipeline Completed. Outbox job created: ${outboxStatus} ---`);',
    'console.log(`--- Pipeline Completed. Outbox job created: ${outboxStatus} ---`);\n      MetricsService.getInstance().recordLatency("INBOUND_PROCESSING", Date.now() - startTime);'
);

fs.writeFileSync('server/services/inboundPipeline.ts', code);
