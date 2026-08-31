const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

const replacement = `
      // 4. Update Conversation Memory
      const convMsgs = await db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.receivedAt);
      
      const convData = {
         id: conversationId,
         contactName: identity.matchedLeadId || email.from, // simplified
         contactEmail: email.from,
         companyName: "Unknown",
         category: 'CUSTOMER',
         thread: convMsgs.map(m => ({
           id: m.id,
           sender: m.direction === 'INBOUND' ? 'PROSPECT' : 'AGENT',
           subject: m.subject,
           bodyText: m.textBody || m.sanitizedHtmlBody || "",
           sentAt: m.receivedAt ? m.receivedAt.toISOString() : new Date().toISOString()
         }))
      } as any;

      const memory = await extractAndSynthesizeMemory(convData);
      
      // Update memory in DB - clear old facts and insert new
      await db.delete(conversationFacts).where(eq(conversationFacts.conversationId, conversationId));
      for (const fact of memory.facts) {
         await db.insert(conversationFacts).values({
            id: \`fact_\${Date.now()}_\${Math.random()}\`,
            conversationId,
            factType: 'GENERAL',
            factText: fact
         });
      }
`;

code = code.replace(/\/\/ await extractAndSynthesizeMemory\(conv, companyBrain\);/, replacement);

fs.writeFileSync('server/services/inboundPipeline.ts', code);
console.log("Updated inbound pipeline to synthesize memory and store to DB");
