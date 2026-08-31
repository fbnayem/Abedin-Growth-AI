const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// Replace globalStore.companyBrain with a dummy object or fetch it if needed.
code = code.replace(/globalStore\.companyBrain/g, "{ companyName: 'My Company' }");
code = code.replace(/import \{ globalStore \} from ".\/server\/dataStore";/g, "");

fs.writeFileSync('server.ts', code);
console.log("Removed globalStore from server.ts");
