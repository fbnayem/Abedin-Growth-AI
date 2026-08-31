const fs = require('fs');

let code = fs.readFileSync('server/services/gmailHistorySync.service.ts', 'utf8');
code = code.replace("// We'll import the pipeline entrypoint later.", "import { inboundPipeline } from './inboundPipeline';");

code = code.replace(/\/\/ await inboundPipeline\.processNewEmail\(fullMessage, gmailAuth\.organizationId\);/, 
  "await inboundPipeline.processNewEmail(fullMessage, gmailAuth.organizationId);");

fs.writeFileSync('server/services/gmailHistorySync.service.ts', code);
console.log("Wired up gmailHistorySync.service.ts to inboundPipeline");
