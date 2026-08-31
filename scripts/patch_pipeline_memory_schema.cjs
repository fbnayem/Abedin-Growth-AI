const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

code = code.replace(/factType: 'GENERAL',\n\s*factText: fact/, 
  "key: 'synthesized_fact',\n            value: fact,\n            sourceType: 'AGENT_SYNTHESIS'");

fs.writeFileSync('server/services/inboundPipeline.ts', code);
console.log("Fixed conversationFacts column names");
