const fs = require('fs');
let content = fs.readFileSync('src/pages/OutboxView.tsx', 'utf8');

content = content.replace(
  /const data = await res\.json\(\);/,
  `const isJson = res.headers.get("content-type")?.includes("application/json");
      if (!isJson) return;
      const data = await res.json();`
);

fs.writeFileSync('src/pages/OutboxView.tsx', content);
console.log("Patched OutboxView");
