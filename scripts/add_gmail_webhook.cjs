const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');
const route = `
  // Gmail Pub/Sub Webhook
  app.post("/api/webhooks/gmail", async (req: Request, res: Response) => {
    try {
      // In production, verify Google Pub/Sub signature
      const message = req.body.message;
      if (!message || !message.data) {
        return res.status(400).send("Bad Request");
      }
      
      const decodedData = Buffer.from(message.data, 'base64').toString('utf8');
      const event = JSON.parse(decodedData);
      
      console.log(\`Received Gmail Pub/Sub event for \${event.emailAddress} (historyId: \${event.historyId})\`);
      
      // We would dispatch this to a GmailHistorySyncService worker.
      // For now, just ack the pubsub message.
      res.status(200).send("OK");
    } catch(e) {
      console.error("Gmail webhook error", e);
      res.status(500).send("Error");
    }
  });
`;

if (!server.includes('/api/webhooks/gmail')) {
    server = server.replace('app.get("*",', route + '\n  app.get("*",');
    fs.writeFileSync('server.ts', server);
    console.log("Added Gmail webhook route");
}
