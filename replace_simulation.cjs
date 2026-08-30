const fs = require('fs');
let file = fs.readFileSync('server/agents/autoReplyEngine.ts', 'utf8');

const anchor = "  const pickedScenario = replyScenarios[Math.floor(Math.random() * replyScenarios.length)];";
const anchorIndex = file.indexOf(anchor);

if (anchorIndex !== -1) {
  const newTail = "  const pickedScenario = replyScenarios[Math.floor(Math.random() * replyScenarios.length)];\n" +
"  const msgId = `msg_client_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;\n\n" +
"  // PHASE 87: Route Simulated Reply through the Multi-Agent Pipeline\n" +
"  const { pipelineService } = await import('../services/pipeline.service.ts');\n" +
"  \n" +
"  await pipelineService.processInboundMessage({\n" +
"    fromEmail: conv.contactEmail,\n" +
"    fromName: conv.contactName,\n" +
"    subject: pickedScenario.subject,\n" +
"    textBody: pickedScenario.bodyText,\n" +
"    providerMessageId: msgId,\n" +
"    threadId: conv.id,\n" +
"    orgId: 'default_org'\n" +
"  });\n\n" +
"  return { success: true, conversation: conv, message: null as any };\n" +
"}\n";

  file = file.substring(0, anchorIndex) + newTail;
  fs.writeFileSync('server/agents/autoReplyEngine.ts', file);
  console.log("Successfully replaced simulation block with Pipeline injection!");
} else {
  console.log("Anchor not found");
}
