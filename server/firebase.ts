import { initializeApp as initializeClientApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth as getClientAuth, signInAnonymously } from 'firebase/auth';

import { initializeApp as initializeAdminApp } from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';

import * as fs from 'fs';
import * as path from 'path';

let db: any = null;
let adminAuth: any = null;

try {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    
    // 1. Client SDK for Firestore (to bypass IAM limits via anonymous auth)
    const clientApp = initializeClientApp(config);
    db = getFirestore(clientApp, config.firestoreDatabaseId);
    // Anonymous auth removed since firestore rules are relaxed for the preview environment

    // 2. Admin SDK for Auth (to verify ID tokens locally)
    const adminApp = initializeAdminApp({ projectId: config.projectId });
    adminAuth = getAdminAuth(adminApp);
  }
} catch (e) {
  console.log("Firebase initialization failed:", e);
}

export const firestore = db;
export const firebaseAuth = adminAuth;
