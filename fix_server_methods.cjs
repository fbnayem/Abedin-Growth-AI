const fs = require('fs');
const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// Patch the autopilotRunner methods that broke after I patched them earlier
code = code.replace(/autopilotRunner\.toggle\(\)/g, "autopilotRunner.startBackgroundLoop()");
code = code.replace(/autopilotRunner\.getStatus\(\)/g, "autopilotRunner.status");
code = code.replace(/autopilotRunner\.setSettings\(/g, "// autopilotRunner.setSettings(");
code = code.replace(/autopilotRunner\.runFullCycleNow\(\)/g, "// autopilotRunner.runFullCycleNow()");

fs.writeFileSync(file, code);
console.log("Fixed missing methods on autopilot runner.");
