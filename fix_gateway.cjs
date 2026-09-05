const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

// The action gateway uses `collection` and `query` already!
// Let's see how it's imported in actionGateway.ts
if (!code.includes("import { collection, query, where, getDocs, doc, getDoc }")) {
    code = `import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';\n` + code;
}

code = code.replace(/await firestore\.collection\('organizations\/org_1\/contacts'\)\.doc\(request\.payload\.contactId\)\.get\(\)/g, "await getDoc(doc(firestore, 'organizations/org_1/contacts', request.payload.contactId))");

fs.writeFileSync('server/gateway/actionGateway.ts', code);
