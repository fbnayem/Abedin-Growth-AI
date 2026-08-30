const fs = require('fs');
let code = fs.readFileSync('server/workers/outbox.worker.ts', 'utf8');

const importStr = `import { circuitBreaker } from '../agents/salesDecisionEngine';\n`;

code = code.replace("export class OutboxWorker {", importStr + "export class OutboxWorker {");

const checkStr = `
    try {
      if (!circuitBreaker.globalAutonomousSendEnabled) {
        // Kill switch is active. Do not process the queue.
        return;
      }
      
      const jobs = await outboxService.fetchPendingJobs(5);`;

code = code.replace(`
    try {
      const jobs = await outboxService.fetchPendingJobs(5);`, checkStr);

fs.writeFileSync('server/workers/outbox.worker.ts', code);
console.log("Updated OutboxWorker to respect circuitBreaker");
