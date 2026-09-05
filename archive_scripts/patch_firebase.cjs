const fs = require('fs');
const file = 'server/firebase.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `    const clientAuth = getClientAuth(clientApp);
    signInAnonymously(clientAuth).catch(e => {
        console.error("Backend anonymous auth failed:", e);
    });`;

const replace = `    // Anonymous auth removed since firestore rules are relaxed for the preview environment`;

code = code.replace(anchor, replace);
fs.writeFileSync(file, code);
