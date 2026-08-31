const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');
server = server.replace(/import \{.*?\} from "\.\/server\/agents\/autoReplyEngine";/s, "");

fs.writeFileSync('server.ts', server);
console.log("Removed autoReplyEngine import from server.ts");
