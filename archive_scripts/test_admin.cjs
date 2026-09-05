const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const config = require('./firebase-applet-config.json');

const app = initializeApp({ projectId: config.projectId });
// Use the named database!
const db = getFirestore(app, config.firestoreDatabaseId);

async function run() {
  try {
     const snap = await db.collection('organizations').get();
     console.log("Success! size:", snap.size);
  } catch(e) {
     console.error("Error:", e.message);
  }
}
run();
