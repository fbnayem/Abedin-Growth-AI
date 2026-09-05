const fs = require('fs');
let code = fs.readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');
code = code.replace('primaryIntent: "SUPPRESS",', 'primaryIntent: "SUPPRESS" as any,');
fs.writeFileSync('server/agents/salesDecisionEngine.ts', code);

code = fs.readFileSync('server/agents/salesEngineTestMatrix.ts', 'utf8');
if (!code.includes('BuyingStage')) {
    code = `import { BuyingStage } from '../../shared/domain/models';\n` + code;
}
fs.writeFileSync('server/agents/salesEngineTestMatrix.ts', code);

code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace("understanding.primaryIntent", "understanding.primaryIntent as any");
fs.writeFileSync('server/services/inboundPipeline.ts', code);
