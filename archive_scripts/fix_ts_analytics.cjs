const fs = require('fs');

let file = fs.readFileSync('server.ts', 'utf8');

// Replace l.score with l.aiScore
file = file.replace(/l.score && l.score > 80/g, 'l.aiScore && l.aiScore > 80');

// Replace c.status !== "NEW" with c.status !== "WAITING_ON_PROSPECT" or just getting all since the type is narrow
file = file.replace(/c\.status !== "NEW"/g, 'c.status !== "CLOSED"');

fs.writeFileSync('server.ts', file);
console.log("Fixed TS errors in server.ts");
