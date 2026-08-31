const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// Dashboard summary replace
const dashboardAnchor = `  // 1. Dashboard summary
  app.get("/api/dashboard", (_req: Request, res: Response) => {
    const qualifiedLeadsCount = globalStore.leads.filter(
      (l) => l.status === "QUALIFIED" || l.status === "ENGAGED" || l.status === "DEMO_SCHEDULED"
    ).length;
    const positiveConversationsCount = globalStore.conversations.filter(
      (c) => c.status === "ACTIVE" || c.status === "HUMAN_NEEDED" || c.status === "MEETING_REQUESTED"
    ).length;
    const meetingsBookedCount = globalStore.meetings.filter((m) => m.status === "CONFIRMED").length;
    const pipelineValue = globalStore.opportunities
      .filter((o) => o.category === "CUSTOMER")
      .reduce((sum, o) => sum + o.estimatedValue, 0);
    const investorConversationsCount = globalStore.investors.filter(
      (i) => i.status === "REPLIED" || i.status === "MEETING_BOOKED"
    ).length;
    const partnerConversationsCount = globalStore.partners.filter(
      (p) => p.status === "CONVERSATION" || p.status === "ACTIVE_PARTNER"
    ).length;

    res.json({
      kpis: {
        qualifiedLeads: qualifiedLeadsCount,
        positiveConversations: positiveConversationsCount,
        meetingsBooked: meetingsBookedCount,
        pipelineValue,
        investorConversations: investorConversationsCount,
        partnerConversations: partnerConversationsCount,
      },
      attentionItems: globalStore.attentionItems,
      dailyBrief: globalStore.dailyBrief,
      status: "AI Growth Engine: Active",
    });
  });`;

const dashboardReplace = `  // 1. Dashboard summary
  app.get("/api/dashboard", async (_req: Request, res: Response) => {
    try {
      if (!firestore) return res.status(500).json({ error: "Firebase not initialized" });
      const orgId = "org_1";
      
      const contactsSnap = await firestore.collection(\`organizations/\${orgId}/contacts\`).get();
      let qualifiedLeadsCount = 0;
      contactsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "QUALIFIED" || s === "ENGAGED" || s === "DEMO_SCHEDULED") qualifiedLeadsCount++;
      });
      
      const convsSnap = await firestore.collection(\`organizations/\${orgId}/conversations\`).get();
      let positiveConversationsCount = 0;
      convsSnap.forEach(doc => {
         const s = doc.data().status;
         if (s === "ACTIVE" || s === "HUMAN_NEEDED" || s === "MEETING_REQUESTED") positiveConversationsCount++;
      });
      
      const meetingsSnap = await firestore.collection(\`organizations/\${orgId}/meetings\`).get();
      let meetingsBookedCount = 0;
      meetingsSnap.forEach(doc => {
         if (doc.data().status === "CONFIRMED") meetingsBookedCount++;
      });
      
      const oppsSnap = await firestore.collection(\`organizations/\${orgId}/opportunities\`).get();
      let pipelineValue = 0;
      oppsSnap.forEach(doc => {
          pipelineValue += (doc.data().value || 0);
      });

      res.json({
        kpis: {
          qualifiedLeads: qualifiedLeadsCount,
          positiveConversations: positiveConversationsCount,
          meetingsBooked: meetingsBookedCount,
          pipelineValue,
          investorConversations: 0,
          partnerConversations: 0,
        },
        attentionItems: [],
        dailyBrief: [],
        status: "AI Growth Engine: Active",
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });`;

code = code.replace(dashboardAnchor, dashboardReplace);
fs.writeFileSync(file, code);
console.log("Dashboard rewritten");
