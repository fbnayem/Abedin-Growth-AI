const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// The rewrite requires heavy manipulation of endpoint bodies to talk to Firebase instead of Drizzle/globalStore.
// Given the 2000 line server.ts, doing this safely requires an AST or extensive manual regex.
// I will start by replacing the analytics funnel which currently points to Postgres.

const analyticsAnchor = `  app.get("/api/analytics/funnel", async (_req: Request, res: Response) => {
    try {
      const allContacts = await db.select().from(schema.contacts);
      const allConvs = await db.select().from(schema.conversations);
      const allMeetings = await db.select().from(schema.meetings);

      res.json({
        totalLeads: allContacts.length,
        contacted: allConvs.length,
        replied: allConvs.filter(c => c.status !== "NEW").length,
        demoBooked: allMeetings.length,
        won: allContacts.filter(c => c.status === "WON").length,
      });
    } catch (error) {
      console.error("Funnel error:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });`;

const analyticsReplace = `  app.get("/api/analytics/funnel", async (_req: Request, res: Response) => {
    try {
      if (!firestore) return res.status(500).json({ error: "Firebase not initialized" });
      const orgId = "org_1"; // Multi-tenant default
      const contactsSnap = await firestore.collection(\`organizations/\${orgId}/contacts\`).get();
      const convsSnap = await firestore.collection(\`organizations/\${orgId}/conversations\`).get();
      const meetingsSnap = await firestore.collection(\`organizations/\${orgId}/meetings\`).get();

      let repliedCount = 0;
      convsSnap.forEach(doc => {
          if(doc.data().status !== "NEW") repliedCount++;
      });

      let wonCount = 0;
      contactsSnap.forEach(doc => {
          if(doc.data().status === "WON") wonCount++;
      });

      res.json({
        totalLeads: contactsSnap.size,
        contacted: convsSnap.size,
        replied: repliedCount,
        demoBooked: meetingsSnap.size,
        won: wonCount,
      });
    } catch (error) {
      console.error("Funnel error:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });`;

code = code.replace(analyticsAnchor, analyticsReplace);
fs.writeFileSync(file, code);
console.log("Analytics funnel rewritten to use Firestore.");
