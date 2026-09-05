const fs = require('fs');
let code = fs.readFileSync('server/gateway/actionGateway.ts', 'utf8');

code = code.replace("import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';\n", "");

fs.writeFileSync('server/gateway/actionGateway.ts', code);
