const { initializeApp } = require('firebase/app');
const { getFirestore, collection, query, where, getDocs } = require('firebase/firestore');
const fs = require('fs');

async function test() {
  const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
  const app = initializeApp(config);
  const db = getFirestore(app, config.firestoreDatabaseId);

  try {
    const q = query(collection(db, 'organizations/org_1/outbox'), where('status', '==', 'PENDING'));
    const snap = await getDocs(q);
    console.log("Success, found:", snap.size);
  } catch (e) {
    console.error("Error:", e.message);
  }
}
test().then(() => process.exit(0));
