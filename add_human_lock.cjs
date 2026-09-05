const fs = require('fs');
let code = fs.readFileSync('server/workers/outbox.worker.ts', 'utf8');

const importStr = `
import { conversations } from '../db/schema';
`;

if (!code.includes('conversations } from')) {
    code = code.replace("import { eq, desc, and }", importStr + "import { eq, desc, and }");
}

const checkLock = `
          // Rule P: HUMAN OWNERSHIP LOCK
          const convRows = await db.select().from(conversations).where(eq(conversations.id, job.conversationId)).limit(1);
          if (convRows.length > 0 && convRows[0].status === 'AUTONOMY_PAUSED_BY_HUMAN') {
              console.warn(\`Human ownership lock active for conversation \${job.conversationId}. Skipping autonomous send.\`);
              await outboxService.markFailed(job.id, 'AUTONOMY_PAUSED_BY_HUMAN');
              continue;
          }
`;

code = code.replace(
    "          // Rule D: STALE DRAFT PROTECTION",
    checkLock + "\n          // Rule D: STALE DRAFT PROTECTION"
);

fs.writeFileSync('server/workers/outbox.worker.ts', code);
