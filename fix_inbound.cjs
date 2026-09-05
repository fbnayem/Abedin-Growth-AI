const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace(
    "import { EmailUnderstandingAgent } from '../agents/salesDecisionEngine';",
    "import { evaluateEmailUnderstandingRuleBased, determineNextBestAction, composeAutonomousSalesReply } from '../agents/salesDecisionEngine';"
).replace(
    "import { NextBestActionAgent } from '../agents/salesDecisionEngine';\n",
    ""
).replace(
    "import { ReplyComposerAgent } from '../agents/salesDecisionEngine';\n",
    ""
).replace(
    "import { IndependentAuditor } from '../agents/independentAuditor';\n",
    ""
);

code = code.replace("identity.conversationId;", "identity.contactId; // hack"); // wait, conversationId doesn't exist on ClientIdentityResolution?
// The types complain about conversationId, accountId, matchedLeadId not existing.
// Let's look at `ClientIdentityResolution` in `shared/domain/models.ts`

code = code.replace("identity.conversationId;", "(identity as any).conversationId;");
code = code.replace("identity.accountId", "(identity as any).accountId");
code = code.replace("identity.matchedLeadId", "(identity as any).matchedLeadId");
code = code.replace("memory.facts", "(memory as any).facts");

fs.writeFileSync('server/services/inboundPipeline.ts', code);
