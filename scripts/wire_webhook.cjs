const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

const replacement = `
      console.log(\`Received Gmail Pub/Sub event for \${event.emailAddress} (historyId: \${event.historyId})\`);
      
      const { gmailHistorySyncService } = require('./server/services/gmailHistorySync.service');
      // Fire and forget so we can ack the webhook immediately
      gmailHistorySyncService.processEvent(event.emailAddress, event.historyId)
        .catch((e: Error) => console.error("Error processing history event:", e));
      
      res.status(200).send("OK");
`;

server = server.replace(/console\.log\(\`Received Gmail Pub\/Sub event.*res\.status\(200\)\.send\("OK"\);/s, replacement);

if (!server.includes('gmailHistorySyncService.processEvent')) {
   fs.writeFileSync('server.ts', server);
   console.log("Wired up Gmail webhook to HistorySyncService");
} else {
   console.log("Already wired");
}
