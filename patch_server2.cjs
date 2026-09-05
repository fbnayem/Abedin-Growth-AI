const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

const targetStr = `        ],\n        createdAt: new Date().toISOString()\n      };`;
const replacementStr = `        ],\n        createdAt: new Date().toISOString(),\n        isABTestingEnabled: !!isABTestingEnabled\n      };`;

code = code.replace(targetStr, replacementStr);
fs.writeFileSync('server.ts', code);
