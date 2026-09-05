const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const anchor = `import { globalStore } from "./server/dataStore";
import { db } from "./server/db/index";
import * as schema from "./server/db/schema";`;

const replace = `import { globalStore } from "./server/dataStore";
import { firestore } from "./server/firebase";`;

if (code.includes(anchor)) {
    code = code.replace(anchor, replace);
    fs.writeFileSync('server.ts', code);
    console.log("Imports updated");
} else {
    console.log("Could not find anchor");
}
