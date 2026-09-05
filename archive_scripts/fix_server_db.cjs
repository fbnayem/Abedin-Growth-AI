const fs = require('fs');

const file = 'server.ts';
let code = fs.readFileSync(file, 'utf8');

// There is still a lingering eq or db somewhere in server.ts
code = code.replace(/await db\.update\(schema\.meetings\)/g, '// await db.update');

fs.writeFileSync(file, code);
