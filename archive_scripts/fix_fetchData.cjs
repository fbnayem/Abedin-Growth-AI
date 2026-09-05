const fs = require('fs');
let content = fs.readFileSync('src/App.tsx', 'utf8');

const replacement = `
    const fetchData = async () => {
      try {
        const [
          dashRes,
          brainRes,
          leadsRes,
          invRes,
          partRes,
          campRes,
          inboxRes,
          pipeRes,
          meetRes,
          knoRes,
          setRes,
          logsRes,
          autoRes,
        ] = await Promise.all([
          fetch("/api/dashboard"),
          fetch("/api/company-brain"),
          fetch("/api/leads"),
          fetch("/api/investors"),
          fetch("/api/partners"),
          fetch("/api/campaigns"),
          fetch("/api/inbox"),
          fetch("/api/pipeline"),
          fetch("/api/meetings"),
          fetch("/api/knowledge"),
          fetch("/api/settings"),
          fetch("/api/logs"),
          fetch("/api/autopilot/status"),
        ]);

        const isJson = (r: Response) => r.headers.get("content-type")?.includes("application/json");

        if (dashRes.ok && isJson(dashRes)) {
          const d = await dashRes.json();
          setKpis(d.kpis);
          setAttentionItems(d.attentionItems || []);
          if (d.dailyBrief) setDailyBrief(d.dailyBrief);
        }
        if (brainRes.ok && isJson(brainRes)) setCompanyBrain(await brainRes.json());
        if (leadsRes.ok && isJson(leadsRes)) setLeads(await leadsRes.json());
        if (invRes.ok && isJson(invRes)) setInvestors(await invRes.json());
        if (partRes.ok && isJson(partRes)) setPartners(await partRes.json());
        if (campRes.ok && isJson(campRes)) setCampaigns(await campRes.json());
        if (inboxRes.ok && isJson(inboxRes)) setConversations(await inboxRes.json());
        if (pipeRes.ok && isJson(pipeRes)) setOpportunities(await pipeRes.json());
        if (meetRes.ok && isJson(meetRes)) setMeetings(await meetRes.json());
        if (knoRes.ok && isJson(knoRes)) setKnowledgeItems(await knoRes.json());
        if (setRes.ok && isJson(setRes)) {
          const s = await setRes.json();
          if (s.autopilot) setGlobalAutopilotConfig(s.autopilot);
        }
        if (logsRes.ok && isJson(logsRes)) setAiLogs(await logsRes.json());
        if (autoRes.ok && isJson(autoRes)) setAutopilotStatus(await autoRes.json());
      } catch (e) {
        if (e instanceof TypeError && e.message === 'Failed to fetch') {
          // Ignore
        } else if (e instanceof SyntaxError && e.message.includes('json')) {
          // Ignore
        } else {
          console.error("Initial fetch error:", e);
        }
      }
    };
`;

const regex = /const fetchData = async \(\) => \{[\s\S]*?console\.error\("Initial fetch error:", e\);\n\s*\}\n\s*\};/;
if (content.match(regex)) {
    content = content.replace(regex, replacement.trim());
    fs.writeFileSync('src/App.tsx', content);
    console.log("Patched fetchData");
} else {
    console.log("Regex didn't match for fetchData.");
}
