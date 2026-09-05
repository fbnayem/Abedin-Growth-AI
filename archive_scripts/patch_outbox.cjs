const fs = require('fs');
const file = 'server/workers/outbox.worker.ts';
let code = fs.readFileSync(file, 'utf8');

const importStr = `import { outboxService } from '../services/outbox.service';`;
const newImportStr = `import { outboxService } from '../services/outbox.service';\nimport { aiSafetyService } from '../services/aiSafety.service';`;
code = code.replace(importStr, newImportStr);

const logicStr = `          console.log(\`Processing outbox job \${job.id} for conversation \${job.conversationId}\`);
          // Need organizationId from conversation to pass to ActionGateway
          const orgId = "org_1"; // Defaulting for now based on migration`;

const newLogicStr = `          console.log(\`Processing outbox job \${job.id} for conversation \${job.conversationId}\`);
          // Need organizationId from conversation to pass to ActionGateway
          const orgId = "org_1"; // Defaulting for now based on migration
          
          // D. STALE DRAFT PROTECTION
          // Verify if a newer inbound message has arrived since this draft was composed.
          const draftVersion = job.payload.draftVersionAtGeneration || 0;
          const isStale = await aiSafetyService.checkStaleDraft(orgId, job.conversationId, draftVersion);
          if (isStale) {
              console.warn(\`[OutboxWorker] Draft \${job.id} is STALE. Newer message arrived. Discarding.\`);
              await outboxService.markFailed(job.id, 'STALE_DRAFT_DISCARDED');
              continue;
          }`;
code = code.replace(logicStr, newLogicStr);

fs.writeFileSync(file, code);
