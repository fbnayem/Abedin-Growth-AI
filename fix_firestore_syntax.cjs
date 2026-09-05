const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// Add imports
if (!code.includes("import { collection, getDocs, addDoc, doc, setDoc, updateDoc, query, where }")) {
    code = `import { collection, getDocs, addDoc, doc, setDoc, updateDoc, query, where } from 'firebase/firestore';\n` + code;
}

// Simple replacements for .get()
code = code.replace(/await firestore\.collection\(`organizations\/\$\{orgId\}\/contacts`\)\.get\(\)/g, "await getDocs(collection(firestore, `organizations/${orgId}/contacts`))");
code = code.replace(/await firestore\.collection\(`organizations\/\$\{orgId\}\/conversations`\)\.get\(\)/g, "await getDocs(collection(firestore, `organizations/${orgId}/conversations`))");
code = code.replace(/await firestore\.collection\(`organizations\/\$\{orgId\}\/meetings`\)\.get\(\)/g, "await getDocs(collection(firestore, `organizations/${orgId}/meetings`))");
code = code.replace(/await firestore\.collection\(`organizations\/\$\{orgId\}\/opportunities`\)\.get\(\)/g, "await getDocs(collection(firestore, `organizations/${orgId}/opportunities`))");

code = code.replace(/await firestore\.collection\('organizations\/org_1\/contacts'\)\.get\(\)/g, "await getDocs(collection(firestore, 'organizations/org_1/contacts'))");
code = code.replace(/await firestore\.collection\('organizations\/org_1\/conversations'\)\.get\(\)/g, "await getDocs(collection(firestore, 'organizations/org_1/conversations'))");
code = code.replace(/await firestore\.collection\('organizations\/org_1\/meetings'\)\.get\(\)/g, "await getDocs(collection(firestore, 'organizations/org_1/meetings'))");
code = code.replace(/await firestore\.collection\('organizations\/org_1\/campaigns'\)\.get\(\)/g, "await getDocs(collection(firestore, 'organizations/org_1/campaigns'))");

// Simple replacements for .add()
code = code.replace(/await firestore\.collection\('organizations\/org_1\/contacts'\)\.add\(\{/g, "await addDoc(collection(firestore, 'organizations/org_1/contacts'), {");
code = code.replace(/await firestore\.collection\('organizations\/org_1\/opportunities'\)\.add\(\{/g, "await addDoc(collection(firestore, 'organizations/org_1/opportunities'), {");
code = code.replace(/await firestore\.collection\('oauth_connections'\)\.add\(\{/g, "await addDoc(collection(firestore, 'oauth_connections'), {");

// The query one
code = code.replace(/await firestore\.collection\('oauth_connections'\)\.where\('organizationId', '==', 'org_1'\)\.where\('provider', '==', 'gmail'\)\.get\(\)/g, "await getDocs(query(collection(firestore, 'oauth_connections'), where('organizationId', '==', 'org_1'), where('provider', '==', 'gmail')))");

// The update one for existing.docs[0].ref.update
// wait, existing.docs[0].ref in client SDK also has update function? No, existing.docs[0].ref is a DocumentReference.
// We can use updateDoc(existing.docs[0].ref, { ... })
code = code.replace(/await existing\.docs\[0\]\.ref\.update\(\{/g, "await updateDoc(existing.docs[0].ref, {");

// Set doc
code = code.replace(/await firestore\.collection\('organizations\/org_1\/campaigns'\)\.doc\(newCampaign\.id\)\.set\(newCampaign\)/g, "await setDoc(doc(firestore, 'organizations/org_1/campaigns', newCampaign.id), newCampaign)");

// Update doc via ref
code = code.replace(/const meetingRef = firestore\.collection\('organizations\/org_1\/meetings'\)\.doc\(meetingId\);\s+await meetingRef\.update\(\{ status: 'CONFIRMED' \}\);/g, "const meetingRef = doc(firestore, 'organizations/org_1/meetings', meetingId);\n        await updateDoc(meetingRef, { status: 'CONFIRMED' });");

// Toggle campaign
code = code.replace(/const docRef = firestore\.collection\('organizations\/org_1\/campaigns'\)\.doc\(req\.params\.id\);\s+const doc = await docRef\.get\(\);/g, "const docRef = doc(firestore, 'organizations/org_1/campaigns', req.params.id);\n      const { getDoc } = require('firebase/firestore');\n      const docSnap = await getDoc(docRef);");
// replace doc.exists and doc.data() and docRef.update
// In client SDK, docSnap.exists() is a method, not a property!
code = code.replace(/if \(!doc\.exists\)/g, "if (!docSnap.exists())");
code = code.replace(/const data = doc\.data\(\) as any;/g, "const data = docSnap.data() as any;");
code = code.replace(/await docRef\.update\(\{ status: newStatus \}\);/g, "await updateDoc(docRef, { status: newStatus });");

// One more toggle: the standalone update
code = code.replace(/const docRef = firestore\.collection\('organizations\/org_1\/campaigns'\)\.doc\(req\.params\.id\);\s+await docRef\.update\(req\.body\);/g, "const docRef = doc(firestore, 'organizations/org_1/campaigns', req.params.id);\n      await updateDoc(docRef, req.body);");


fs.writeFileSync('server.ts', code);
