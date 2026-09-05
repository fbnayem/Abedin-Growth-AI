const fs = require('fs');

let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace(
    "const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY, nextBestAction: nbaResult, prospectName: email.from });",
    "const draft = await composeAutonomousSalesReply({ incomingEmail: email.textBody, latestIntent: understanding.primaryIntent, buyingStage: BuyingStage.DISCOVERY, nextBestAction: nbaResult, prospectName: email.from } as any);"
);
fs.writeFileSync('server/services/inboundPipeline.ts', code);

code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');
code = code.replace(
    'return { \n       isResolved: !!contactId as any,\n       resolutionMethod: resolutionMethod as any,\n       matchedLeadId: contactId,\n       contactId,\n       accountId,\n       conversationId,\n       confidence,\n       provenance: `DB match on ${resolutionMethod}`,\n       suggestedAction: \'PROCEED\'\n    };',
    'return { \n       isResolved: !!contactId as any,\n       resolutionMethod: resolutionMethod as any,\n       matchedLeadId: contactId,\n       contactId,\n       accountId,\n       conversationId,\n       confidence,\n       provenance: `DB match on ${resolutionMethod}`,\n       suggestedAction: \'PROCEED\'\n    } as any;'
);
fs.writeFileSync('server/services/identityResolver.service.ts', code);
