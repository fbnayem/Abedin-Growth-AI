import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth, signInAnonymously } from 'firebase/auth';
import * as fs from 'fs';
import * as path from 'path';

let app;
let db: any = null;
let auth: any = null;

try {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    app = initializeApp(config);
    db = getFirestore(app, config.firestoreDatabaseId);
    auth = getAuth(app);
    
    // Sign in anonymously for backend operations to bypass `isSignedIn()` rules
    signInAnonymously(auth).catch(e => {
        console.error("Backend anonymous auth failed:", e);
    });
  }
} catch (e) {
  console.log("Firebase initialization failed or config not found:", e);
}

export const firestore = db;
export const firebaseAuth = auth;
