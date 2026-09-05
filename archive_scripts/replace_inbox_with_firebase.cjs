const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

const getInboxAnchor = `  // 3. Inbox (Conversations) endpoints using Drizzle
  app.get("/api/inbox", async (_req: Request, res: Response) => {
    try {
      const records = await db.select().from(schema.conversations);
      res.json(records);
    } catch (error) {
      console.error("Fetch inbox error:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });`;

const getInboxReplace = `  // 3. Inbox (Conversations) endpoints using Firestore
  app.get("/api/inbox", async (_req: Request, res: Response) => {
    try {
      if (!firestore) return res.status(500).json({ error: "Firebase not initialized" });
      const orgId = "org_1";
      const snap = await firestore.collection(\`organizations/\${orgId}/conversations\`).get();
      const records: any[] = [];
      snap.forEach(doc => records.push(doc.data()));
      res.json(records);
    } catch (error) {
      console.error("Fetch inbox error:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });`;

code = code.replace(getInboxAnchor, getInboxReplace);
fs.writeFileSync(file, code);
console.log("Inbox GET endpoint rewritten to use Firestore.");
