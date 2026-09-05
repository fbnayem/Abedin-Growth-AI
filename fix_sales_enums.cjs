const fs = require('fs');
let code = fs.readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');

const mapping = {
    '"UNSUBSCRIBED"': "BuyingStage.UNSUBSCRIBED",
    '"NOT_INTERESTED"': "BuyingStage.NOT_INTERESTED",
    '"PURCHASE_READY"': "BuyingStage.PURCHASE_READY",
    '"NEGOTIATION"': "BuyingStage.NEGOTIATION",
    '"DEMO_READY"': "BuyingStage.DEMO_READY",
    '"COMMERCIAL_EVALUATION"': "BuyingStage.COMMERCIAL_EVALUATION",
    '"TECHNICAL_EVALUATION"': "BuyingStage.TECHNICAL_EVALUATION",
    '"PRODUCT_EVALUATING"': "BuyingStage.PRODUCT_EVALUATING",
    '"SOLUTION_EXPLORING"': "BuyingStage.SOLUTION_EXPLORING",
};

for (const [key, val] of Object.entries(mapping)) {
    code = code.split(key).join(val);
}
fs.writeFileSync('server/agents/salesDecisionEngine.ts', code);
