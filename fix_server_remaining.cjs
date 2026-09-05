const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// I will just find and delete the blocks of these endpoints to keep things clean.
const endpointsToRemove = [
    'app.post("/api/inbox/auto-reply-all"',
    'app.post("/api/inbox/circuit-breaker/toggle"',
    'app.post("/api/inbox/simulate-reply"',
    'app.post("/api/inbox/:id/simulate-reply"',
    'app.post("/api/inbox/sales-decision-engine/inspect"',
    'app.post("/api/inbox/deep-audit"',
    'app.get("/api/settings"',
    'app.post("/api/settings/token"'
];

const lines = code.split('\n');
let newLines = [];
let inRoute = false;
let routeLines = [];
let braceDepth = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let isTarget = false;
    
    if (!inRoute && (line.match(/^  app\.(get|post|put|delete)\("/) || line.match(/^app\.(get|post|put|delete)\("/))) {
        inRoute = true;
        routeLines = [];
        braceDepth = 0;
    }
    
    if (inRoute) {
        routeLines.push(line);
        // simple brace counting
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth += opens - closes;
        
        if (braceDepth <= 0 && line.trim().endsWith('});')) {
            inRoute = false;
            let routeCode = routeLines.join('\n');
            let shouldDrop = endpointsToRemove.some(e => routeCode.includes(e));
            if (!shouldDrop) {
                newLines.push(...routeLines);
            }
        }
    } else {
        newLines.push(line);
    }
}

// Also fix `updated` at the end
newLines = newLines.map(l => {
    if (l.includes("updated = { ...autopilotRunner, status: autopilotRunner.status, stageDetail: autopilotRunner.stageDetail };")) {
        return "      const updated = { ...autopilotRunner, status: autopilotRunner.status, stageDetail: autopilotRunner.stageDetail };";
    }
    return l;
});

fs.writeFileSync('server.ts', newLines.join('\n'));
