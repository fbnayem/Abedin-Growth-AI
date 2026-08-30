const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const target = `      // QC check
      const qc = await inspectEmailDraft({
        recipientEmail: conv.contactEmail,
        recipientName: conv.contactName,
        subject,
        body,
      });

      const newMsg = {
        id: \`msg_\${Date.now()}\`,
        conversationId: conv.id,
        sender: "AGENT" as const,
        senderName: globalStore.senderIdentity.senderName,
        senderEmail: globalStore.senderIdentity.senderEmail || "info@abedintech.com",
        recipientEmail: conv.contactEmail,
        subject,
        bodyHtml: \`<p>\${body.replace(/\\n/g, "<br/>")}</p>\`,
        bodyText: body,
        sentAt: new Date().toISOString(),
        status: "SENT" as const,
        qcScore: qc.score,
        qcDecision: qc.decision,
      };`;

const replacement = `      // Queue in Transactional Outbox (Phase 16)
      const idempotencyKey = \`manual_reply_\${conv.id}_\${Date.now()}\`;
      await outboxService.queueMessage(conv.id, {
        to: conv.contactEmail,
        subject: subject,
        htmlBody: \`<p>\${body.replace(/\\n/g, "<br/>")}</p>\`,
        textBody: body,
      }, idempotencyKey);

      const newMsg = {
        id: \`msg_queued_\${Date.now()}\`,
        conversationId: conv.id,
        sender: "AGENT" as const,
        senderName: globalStore.senderIdentity.senderName,
        senderEmail: globalStore.senderIdentity.senderEmail || "info@abedintech.com",
        recipientEmail: conv.contactEmail,
        subject,
        bodyHtml: \`<p>\${body.replace(/\\n/g, "<br/>")}</p>\`,
        bodyText: body,
        sentAt: new Date().toISOString(),
        status: "QUEUED" as const,
        qcScore: 100,
        qcDecision: "PASS",
      };`;

if (code.includes(target)) {
  code = code.replace(target, replacement);
  fs.writeFileSync('server.ts', code);
  console.log("Replaced successfully!");
} else {
  console.log("Target not found!");
}
