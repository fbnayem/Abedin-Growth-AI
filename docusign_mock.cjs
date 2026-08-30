const fs = require('fs');

const docusignRoute = `
// eSignature routes (DocuSign/PandaDoc Webhook)
app.post("/api/signature/webhook", express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    // In a real app we verify the HMAC signature from DocuSign here
    const event = JSON.parse(req.body.toString());
    
    if (event.event === 'envelope-completed') {
      const meetingId = event.data.envelopeSummary.customFields.customField.find((f: any) => f.name === 'meetingId')?.value;
      if (meetingId) {
        console.log(\`DocuSign webhook received for meeting: \${meetingId}\`);
        await db.update(schema.meetings).set({ status: 'CONFIRMED' }).where(eq(schema.meetings.id, meetingId));
      }
    }
    res.status(200).send("OK");
  } catch(e) {
    console.error("DocuSign webhook error", e);
    res.status(500).send("Error");
  }
});
`;

let code = fs.readFileSync('server.ts', 'utf8');
if (!code.includes('/api/signature/webhook')) {
  code = code.replace('app.get("*",', docusignRoute + '\n  app.get("*",');
  fs.writeFileSync('server.ts', code);
  console.log("Added signature webhook");
}
