const { firestore } = require('./server/firebase');

async function test() {
    if (firestore) {
        console.log("Firestore initialized.");
        try {
           const snap = await firestore.collection('organizations').get();
           console.log("Docs found:", snap.size);
        } catch(e) {
           console.error("Firestore test failed:", e);
        }
    } else {
        console.log("Firestore null");
    }
}
test();
