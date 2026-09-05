const fs = require('fs');
let file = fs.readFileSync('server/agents/autoReplyEngine.ts', 'utf8');

const anchor = "const res = await autoReplyToConversation(conv.id);";
const replacement = `
      // Route to Pipeline
      const { pipelineService } = await import('../services/pipeline.service.ts');
      const lastMessage = conv.thread[conv.thread.length - 1];
      await pipelineService.processInboundMessage({
        fromEmail: conv.contactEmail,
        fromName: conv.contactName,
        subject: lastMessage?.subject || "No Subject",
        textBody: lastMessage?.bodyText || "",
        providerMessageId: lastMessage?.id || \`msg_\${Date.now()}\`,
        threadId: conv.id,
        orgId: "default_org"
      });
      
      const res = {
        success: true,
        conversationId: conv.id,
        recipientEmail: conv.contactEmail,
        subject: "Processing",
        bodyText: "Routed to Pipeline",
        sentAt: new Date().toISOString()
      };
`;

file = file.replace(anchor, replacement);
fs.writeFileSync('server/agents/autoReplyEngine.ts', file);
console.log("Successfully replaced autoReplyAll loop with Pipeline.");
