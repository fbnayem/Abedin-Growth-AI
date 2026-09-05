const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');

async function test() {
  const config = JSON.parse(fs.readFileSync('firebase-applet-config.json', 'utf8'));
  const app = initializeApp(config);
  const db = getFirestore(app, config.firestoreDatabaseId);

  try {
    const snap = await getDoc(doc(db, 'system/test'));
    console.log("Success, exists:", snap.exists());
  } catch (e) {
    console.error("Error:", e.message);
  }
}
test().then(() => process.exit(0));
