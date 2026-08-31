import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import * as fs from 'fs';
import * as path from 'path';

let app;

try {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    // In server environment, we don't have service account credentials by default in this preview env.
    // However, the Firebase skill notes "firebase-applet-config.json has been generated".
    // We will initialize the admin SDK using default credentials which the container has.
    app = initializeApp();
  }
} catch (e) {
  console.log("Firebase admin initialization failed or config not found:", e);
}

export const firestore = app ? getFirestore(app) : null;
export const firebaseAuth = app ? getAuth(app) : null;
