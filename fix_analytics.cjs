const fs = require('fs');
let content = fs.readFileSync('src/pages/AnalyticsView.tsx', 'utf8');

content = content.replace(
  /fetch\('\/api\/analytics\/funnel'\)\n\s*\.then\(res => res\.json\(\)\)/,
  `fetch('/api/analytics/funnel')
      .then(res => {
        if (!res.headers.get("content-type")?.includes("application/json")) {
          throw new Error("Invalid content-type");
        }
        return res.json();
      })`
);

fs.writeFileSync('src/pages/AnalyticsView.tsx', content);
console.log("Patched AnalyticsView");
