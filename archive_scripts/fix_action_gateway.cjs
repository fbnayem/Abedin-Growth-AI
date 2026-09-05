const fs = require('fs');
const file = 'server/gateway/actionGateway.ts';
let code = fs.readFileSync(file, 'utf8');

const importStr = `import { firestore } from '../firebase';`;
const newImportStr = `import { firestore } from '../firebase';
import { collection, doc, getDoc, getDocs, setDoc, query, where } from 'firebase/firestore';`;
code = code.replace(importStr, newImportStr);

const oldCheckLock = `    try {
      const doc = await firestore.collection(\`organizations/\${orgId}/conversations\`).doc(conversationId).get();
      if (doc.exists) {
        const data = doc.data();`;
const newCheckLock = `    try {
      const docSnap = await getDoc(doc(firestore, \`organizations/\${orgId}/conversations\`, conversationId));
      if (docSnap.exists()) {
        const data = docSnap.data();`;
code = code.replace(oldCheckLock, newCheckLock);

const oldLogAction = `    try {
      await firestore.collection(\`organizations/\${request.organizationId}/actionLogs\`).doc(actionId).set({
        actionId,`;
const newLogAction = `    try {
      await setDoc(doc(firestore, \`organizations/\${request.organizationId}/actionLogs\`, actionId), {
        actionId,`;
code = code.replace(oldLogAction, newLogAction);

const oldLogActionEnd = `        timestamp: new Date()
      }, { merge: true });`;
const newLogActionEnd = `        timestamp: Date.now()
      }, { merge: true });`;
code = code.replace(oldLogActionEnd, newLogActionEnd);

const oldExecuteEmail = `        if (!firestore) return { success: false, error: 'Firestore not initialized' };
        // Fetch oauth token for organization
        const oauthsSnap = await firestore.collection('oauth_connections').where('organizationId', '==', request.organizationId).get();
        let accessToken = 'mock_token';
        oauthsSnap.forEach(doc => {`;
const newExecuteEmail = `        if (!firestore) return { success: false, error: 'Firestore not initialized' };
        // Fetch oauth token for organization
        const q = query(collection(firestore, 'oauth_connections'), where('organizationId', '==', request.organizationId));
        const oauthsSnap = await getDocs(q);
        let accessToken = 'mock_token';
        oauthsSnap.forEach(doc => {`;
code = code.replace(oldExecuteEmail, newExecuteEmail);

fs.writeFileSync(file, code);
