const fs = require('fs');
let code = fs.readFileSync('server/workers/outbox.worker.ts', 'utf8');

const importDB = `
import { eq } from 'drizzle-orm';
import { oauthConnections } from '../db/schema';
`;

// Replace `await gmailService.sendEmail({` with a block that fetches the token first.
const dbFetchCode = `
          // Get the organizationId for the conversation to fetch the right token
          // Since outboxMessages has conversationId, we need to join conversations to get orgId.
          const convRows = await db.select().from(messages).where(eq(messages.id, 'dummy')).limit(0); // wait, easier to just query conversations
          const { conversations } = require('../db/schema');
          const convs = await db.select().from(conversations).where(eq(conversations.id, job.conversationId));
          const orgId = convs.length > 0 ? convs[0].organizationId : "default";

          const oauths = await db.select().from(oauthConnections).where(eq(oauthConnections.organizationId, orgId));
          const gmailAuth = oauths.find(o => o.provider === 'GMAIL');
          
          if (!gmailAuth || !gmailAuth.accessToken) {
             throw new Error("No valid Gmail OAuth connection found for organization: " + orgId);
          }
          
          gmailService.setCredentials({ access_token: gmailAuth.accessToken });

          const result = await gmailService.sendEmail({`;

if (!code.includes('oauthConnections')) {
    code = code.replace("import { v4 as uuidv4 } from 'uuid';", "import { v4 as uuidv4 } from 'uuid';\n" + importDB);
    code = code.replace("const result = await gmailService.sendEmail({", dbFetchCode);
    fs.writeFileSync('server/workers/outbox.worker.ts', code);
    console.log("Patched outbox worker to use database oauth tokens");
}
