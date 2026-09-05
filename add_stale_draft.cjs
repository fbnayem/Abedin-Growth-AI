const fs = require('fs');
let code = fs.readFileSync('server/workers/outbox.worker.ts', 'utf8');

const importStr = `
import { db } from '../db/index';
import { messages } from '../db/schema';
import { eq, desc, and } from 'drizzle-orm';
`;

if (!code.includes('import { db }')) {
    code = code.replace("import { firestore }", importStr + "import { firestore }");
}

const staleCheck = `
          // Rule D: STALE DRAFT PROTECTION
          // Reload conversation messages to see if a newer inbound message arrived after this job was queued
          const latestInbound = await db.select()
              .from(messages)
              .where(
                  and(
                      eq(messages.conversationId, job.conversationId),
                      eq(messages.direction, 'INBOUND')
                  )
              )
              .orderBy(desc(messages.receivedAt))
              .limit(1);

          if (latestInbound.length > 0 && latestInbound[0].receivedAt && latestInbound[0].receivedAt > job.createdAt) {
              console.warn(\`Stale draft detected for conversation \${job.conversationId}. A newer inbound message has arrived. Invalidating draft.\`);
              await outboxService.markFailed(job.id, 'STALE_DRAFT: Newer inbound message arrived before send.');
              continue; // Skip sending
          }
`;

code = code.replace(
    '          const orgId = "org_1"; // Defaulting for now based on migration',
    staleCheck + '\n          const orgId = "org_1"; // Defaulting for now based on migration'
);

fs.writeFileSync('server/workers/outbox.worker.ts', code);
