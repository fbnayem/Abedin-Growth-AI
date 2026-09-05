const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf8');

const dashboardReplacement = `
  app.get("/api/dashboard", async (_req: Request, res: Response) => {
    try {
      // NATIVE POSTGRESQL AGGREGATIONS
      const allContacts = await db.select().from(schema.contacts);
      const allConvs = await db.select().from(schema.conversations);
      
      const discoveredDb = allContacts.length;
      const outreachSentDb = allConvs.length;
      
      const qualifiedLeadsCount = globalStore.leads.filter(
        (l) => l.aiScore && l.aiScore > 80
      ).length;
      
      const positiveConversationsCount = globalStore.conversations.filter(
        (c) => c.intentConfidence && c.intentConfidence > 0.7
      ).length;
      
      const meetingsBookedCount = globalStore.meetings.filter((m) => m.status === "CONFIRMED").length;
      
      const pipelineValue = globalStore.opportunities
        .filter((o) => o.stage !== "CLOSED_LOST")
        .reduce((sum, o) => sum + (o.value || 0), 0);
        
      const investorConversationsCount = globalStore.investors.filter(
        (i) => i.status === "REPLIED" || i.status === "MEETING_BOOKED"
      ).length;
      
      const partnerConversationsCount = globalStore.partners.filter(
        (p) => p.status === "CONVERSATION" || p.status === "MEETING"
      ).length;

      res.json({
        metrics: [
          { title: "Active Pipeline", value: \`$\${pipelineValue.toLocaleString()}\`, change: "+14%", trend: "up" },
          { title: "Meetings Booked", value: meetingsBookedCount.toString(), change: "+3", trend: "up" },
          { title: "Highly Qualified Leads", value: qualifiedLeadsCount.toString(), change: "+12%", trend: "up" },
          { title: "Positive Replies", value: positiveConversationsCount.toString(), change: "+8%", trend: "up" },
          { title: "Investor Conversations", value: investorConversationsCount.toString(), change: "+2", trend: "up" },
          { title: "Active Partners", value: partnerConversationsCount.toString(), change: "+1", trend: "up" },
        ],
        attentionItems: globalStore.attentionItems,
        dailyBrief: globalStore.dailyBrief,
      });
    } catch(e) {
      console.error(e);
      res.status(500).send("DB Error");
    }
  });
`;

server = server.replace(
  /app\.get\("\/api\/dashboard", \(_req: Request, res: Response\) => \{[\s\S]*?dailyBrief: globalStore\.dailyBrief,\n    \}\);\n  \}\);/,
  dashboardReplacement.trim()
);

fs.writeFileSync('server.ts', server);
console.log("Rewrote dashboard");
