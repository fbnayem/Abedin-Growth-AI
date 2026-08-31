const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/await db\.update\(schema\.meetings\)\.set\(\{ status: 'CONFIRMED' \}\)\.where\(eq\(schema\.meetings\.id, meetingId\)\);/g, `
        const meetingRef = firestore.collection('organizations/org_1/meetings').doc(meetingId);
        await meetingRef.update({ status: 'CONFIRMED' });
`);

fs.writeFileSync(file, code);
console.log("Fixed meeting update");
