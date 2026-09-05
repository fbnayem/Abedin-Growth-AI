const fs = require('fs');

let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace(
    /const draft = await composeAutonomousSalesReply\(\{ incomingEmail: email\.textBody, latestIntent: understanding\.primaryIntent, buyingStage: BuyingStage\.DISCOVERY, nextBestAction: nbaResult, prospectName: email\.from \}\);/g,
    "const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY, nextBestAction: nbaResult, prospectName: email.from } as any);"
);
fs.writeFileSync('server/services/inboundPipeline.ts', code);

code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');
code = code.replace(/return \{[\s\S]*?suggestedAction: 'PROCEED'[\s\S]*?\};/, function(match) {
    return match.replace("};", "} as any;");
});
fs.writeFileSync('server/services/identityResolver.service.ts', code);
