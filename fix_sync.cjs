const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf8');

const replacement = `
  const syncLiveEngineData = async () => {
    try {
      const [autoRes, dashRes, leadsRes, invRes, inboxRes, logsRes] = await Promise.all([
        fetch("/api/autopilot/status"),
        fetch("/api/dashboard"),
        fetch("/api/leads"),
        fetch("/api/investors"),
        fetch("/api/inbox"),
        fetch("/api/logs"),
      ]);

      const isJson = (res: Response) => res.headers.get("content-type")?.includes("application/json");

      if (autoRes.ok && isJson(autoRes)) {
        const data: AutopilotStatusState = await autoRes.json();
        setAutopilotStatus(data);
      }
      if (dashRes.ok && isJson(dashRes)) {
        const d = await dashRes.json();
        setKpis(d.kpis);
        if (d.dailyBrief) setDailyBrief(d.dailyBrief);
        if (d.attentionItems) setAttentionItems(d.attentionItems);
      }
      if (leadsRes.ok && isJson(leadsRes)) {
        const freshLeads = await leadsRes.json();
        setLeads(freshLeads);
      }
      if (invRes.ok && isJson(invRes)) {
        const freshInv = await invRes.json();
        setInvestors(freshInv);
      }
      if (inboxRes.ok && isJson(inboxRes)) {
        const freshInbox = await inboxRes.json();
        setConversations(freshInbox);
      }
      if (logsRes.ok && isJson(logsRes)) {
        const freshLogs = await logsRes.json();
        setAiLogs(freshLogs);
      }
    } catch (e) {
      if (e instanceof TypeError && e.message === 'Failed to fetch') {
        // Ignore dev server restart disconnect
      } else if (e instanceof SyntaxError && e.message.includes('json')) {
        // Ignore benign HTML response during dev server restart
      } else {
        console.error("Live data sync error:", e);
      }
    }
  };
`;

const regex = /const syncLiveEngineData = async \(\) => \{[\s\S]*?console\.error\("Live data sync error:", e\);\n\s*\}\n\s*\}\n\s*\};/;
if (content.match(regex)) {
    content = content.replace(regex, replacement.trim());
    fs.writeFileSync('src/App.tsx', content);
    console.log("Patched syncLiveEngineData");
} else {
    console.log("Regex didn't match.");
}
