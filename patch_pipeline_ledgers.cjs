const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

const importStr = "import { LedgerService } from './ledgers.service';\n";
if (!code.includes('LedgerService')) {
    code = importStr + code;
}

const hookStr = `
      // --- LEDGERS CHECK ---
      const ledgerService = new LedgerService();
      const unresolvedCommitments = await ledgerService.getUnresolvedCommitments(identity.contactId as any);
      if (unresolvedCommitments.length > 0) {
          console.warn('Unresolved commitments exist, passing to auditor context.');
      }
      const openQuestions = await ledgerService.getOpenQuestions(conversationId);
      const unresolvedObjections = await ledgerService.getUnresolvedObjections(conversationId);
`;

code = code.replace(
    "const nbaResult = determineNextBestAction(understanding, BuyingStage.DISCOVERY as any, {} as any, {} as any);",
    "const nbaResult = determineNextBestAction(understanding, BuyingStage.DISCOVERY as any, {} as any, {} as any);\n" + hookStr
);

fs.writeFileSync('server/services/inboundPipeline.ts', code);
