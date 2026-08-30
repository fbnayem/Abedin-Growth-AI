const fs = require('fs');

let file = fs.readFileSync('server.ts', 'utf8');

const targetString = '  // 2. Company Brain';

const injection = `
  app.get("/api/analytics/funnel", (_req: Request, res: Response) => {
    // Phase 34: Analytics Rebuilding
    const discovered = globalStore.leads.length + globalStore.investors.length + globalStore.partners.length;
    const qualified = globalStore.leads.filter(l => l.score && l.score > 80).length;
    const outreachSent = globalStore.conversations.length; // Approximate
    const opened = globalStore.conversations.filter(c => c.unread === false).length;
    const replied = globalStore.conversations.filter(c => c.status !== "NEW").length;
    const positive = globalStore.conversations.filter(c => c.intentConfidence && c.intentConfidence > 0.8).length;
    const demoBooked = globalStore.meetings.length;

    res.json({
      funnel: [
        { label: "1. Discovered", count: discovered, dropoff: "100%", color: "bg-slate-700" },
        { label: "2. AI Qualified (Score > 80)", count: qualified, dropoff: discovered ? \`\${((qualified/discovered)*100).toFixed(1)}%\` : "0%", color: "bg-blue-600" },
        { label: "3. Outreach Sent", count: outreachSent, dropoff: qualified ? \`\${((outreachSent/qualified)*100).toFixed(1)}%\` : "0%", color: "bg-indigo-600" },
        { label: "4. Opened", count: opened, dropoff: outreachSent ? \`\${((opened/outreachSent)*100).toFixed(1)}% Open Rate\` : "0%", color: "bg-purple-600" },
        { label: "5. Replied", count: replied, dropoff: opened ? \`\${((replied/opened)*100).toFixed(1)}% Reply Rate\` : "0%", color: "bg-amber-600" },
        { label: "6. Positive Intent", count: positive, dropoff: replied ? \`\${((positive/replied)*100).toFixed(1)}% Positivity\` : "0%", color: "bg-emerald-600" },
        { label: "7. Demo Booked", count: demoBooked, dropoff: positive ? \`\${((demoBooked/positive)*100).toFixed(1)}% Conversion\` : "0%", color: "bg-emerald-500" },
      ]
    });
  });
`;

if (file.includes(targetString)) {
  file = file.replace(targetString, injection + '\n' + targetString);
  fs.writeFileSync('server.ts', file);
  console.log("Successfully added /api/analytics/funnel.");
} else {
  console.log("Target not found");
}
