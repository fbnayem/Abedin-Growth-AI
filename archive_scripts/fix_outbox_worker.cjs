const fs = require('fs');
const file = 'server/workers/outbox.worker.ts';
let code = fs.readFileSync(file, 'utf8');

const importStr = `import { firestore } from '../firebase';`;
const newImportStr = `import { firestore } from '../firebase';\nimport { collection, addDoc } from 'firebase/firestore';`;
code = code.replace(importStr, newImportStr);

const oldCreate = `             // Create message record
             await firestore.collection(\`organizations/\${orgId}/conversations/\${job.conversationId}/messages\`).add({`;
const newCreate = `             // Create message record
             await addDoc(collection(firestore, \`organizations/\${orgId}/conversations/\${job.conversationId}/messages\`), {`;
code = code.replace(oldCreate, newCreate);

fs.writeFileSync(file, code);
