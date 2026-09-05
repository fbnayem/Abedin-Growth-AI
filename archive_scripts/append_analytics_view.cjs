const fs = require('fs');
let file = fs.readFileSync('src/pages/AnalyticsView.tsx', 'utf8');

const stateRegex = /const funnelSteps = \[\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\{[^\}]+\},\s*\];/g;

const stateReplacement = `  const [funnelSteps, setFunnelSteps] = React.useState<any[]>([
    { label: "1. Discovered", count: 0, dropoff: "100%", color: "bg-slate-700" },
    { label: "2. AI Qualified (Score > 80)", count: 0, dropoff: "0%", color: "bg-blue-600" },
    { label: "3. Outreach Sent", count: 0, dropoff: "0%", color: "bg-indigo-600" },
    { label: "4. Opened", count: 0, dropoff: "0% Open Rate", color: "bg-purple-600" },
    { label: "5. Replied", count: 0, dropoff: "0% Reply Rate", color: "bg-amber-600" },
    { label: "6. Positive Intent", count: 0, dropoff: "0% Positivity", color: "bg-emerald-600" },
    { label: "7. Demo Booked", count: 0, dropoff: "0% Conversion", color: "bg-emerald-500" },
  ]);

  React.useEffect(() => {
    fetch('/api/analytics/funnel')
      .then(res => res.json())
      .then(data => {
        if (data.funnel) {
          setFunnelSteps(data.funnel);
        }
      })
      .catch(e => console.error("Failed to load analytics", e));
  }, []);`;

file = file.replace(stateRegex, stateReplacement);

// Fallback if regex fails (manual slice)
if (!file.includes("setFunnelSteps")) {
  const parts = file.split('const funnelSteps = [');
  if (parts.length === 2) {
    const p2 = parts[1].split('];');
    if (p2.length > 1) {
      p2.shift(); // remove the old array content
      file = parts[0] + stateReplacement + p2.join('];');
    }
  }
}

fs.writeFileSync('src/pages/AnalyticsView.tsx', file);
console.log("Successfully updated AnalyticsView.");
