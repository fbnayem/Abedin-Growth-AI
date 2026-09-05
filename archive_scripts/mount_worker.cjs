const fs = require('fs');
let file = fs.readFileSync('server.ts', 'utf8');
if (!file.includes('outboxWorker')) {
  file = file.replace('import { requireAuth } from "./server/middleware/auth";', 'import { requireAuth } from "./server/middleware/auth";\nimport { outboxWorker } from "./server/workers/outbox.worker";');
  file = file.replace('app.listen(PORT', 'outboxWorker.start();\n\n  app.listen(PORT');
  fs.writeFileSync('server.ts', file);
  console.log("Mounted outboxWorker");
}
