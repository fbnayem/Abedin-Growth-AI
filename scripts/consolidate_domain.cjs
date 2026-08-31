const fs = require('fs');
let typesStr = fs.readFileSync('src/types.ts', 'utf8');
let modelsStr = fs.readFileSync('shared/domain/models.ts', 'utf8');

// The enums from shared/domain/models.ts:
// EmailStatus, MeetingStatus, PaymentStatus, ContractStatus, BuyingStage, MessageDirection, NextBestAction

// Let's remove any duplicates in src/types.ts (if any exist, though types.ts uses string literals usually)
// types.ts has:
// export type LeadStatus = 'NEW' | 'QUALIFIED' | ...
// export type PipelineStage = LeadStatus;
// We need to merge everything correctly.

fs.writeFileSync('shared/domain/models.ts', modelsStr + '\n' + typesStr);
console.log('Merged src/types.ts into shared/domain/models.ts');
