const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

const importStr = "import { BudgetTracker } from '../policies/workflowBudgets';\n";
if (!code.includes('BudgetTracker')) {
    code = importStr + code;
}

code = code.replace(
    'try {\n      const startTime = Date.now();',
    'try {\n      const startTime = Date.now();\n      const budgetTracker = new BudgetTracker();\n      budgetTracker.recordStep();'
);

code = code.replace(
    /const draft = await composeAutonomousSalesReply\([\s\S]*?\}\);/g,
    function(match) {
        return 'budgetTracker.recordModelCall(500, 0.01); // Mock cost\n      ' + match;
    }
);

fs.writeFileSync('server/services/inboundPipeline.ts', code);
