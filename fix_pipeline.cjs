const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace(
    /const draft = await composeAutonomousSalesReply\([\s\S]*?\}\);/,
    "const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY, nextBestAction: nbaResult, prospectName: email.from } as any);"
);
fs.writeFileSync('server/services/inboundPipeline.ts', code);
