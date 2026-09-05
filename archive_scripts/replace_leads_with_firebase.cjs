const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `  // 2. Leads (Contacts) endpoints using Drizzle
  app.get("/api/leads", async (_req: Request, res: Response) => {
    try {
      const records = await db.select().from(schema.contacts);
      res.json(records);
    } catch (error) {
      console.error("Fetch leads error:", error);
      // Merge with any legacy globalStore leads that haven't migrated yet
      const legacyIds = new Set(globalStore.leads.map(l => l.id));
      const legacyLeads = globalStore.leads.filter(l => !legacyIds.has(l.id));
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });`;

const replace = `  // 2. Leads (Contacts) endpoints using Firestore
  app.get("/api/leads", async (_req: Request, res: Response) => {
    try {
      if (!firestore) return res.status(500).json({ error: "Firebase not initialized" });
      const orgId = "org_1";
      const snap = await firestore.collection(\`organizations/\${orgId}/contacts\`).get();
      const records: any[] = [];
      snap.forEach(doc => records.push(doc.data()));
      res.json(records);
    } catch (error) {
      console.error("Fetch leads error:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });`;

code = code.replace(anchor, replace);
fs.writeFileSync(file, code);
console.log("Leads endpoints rewritten to use Firestore.");
