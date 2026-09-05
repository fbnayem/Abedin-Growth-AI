const fs = require('fs');

// Patch App.tsx
let appCode = fs.readFileSync('src/App.tsx', 'utf8');
appCode = appCode.replace(
  '    investorConversations: 3,\n    partnerConversations: 4,\n  });',
  '    investorConversations: 3,\n    partnerConversations: 4,\n    projectedMonthlyRevenue: 12000,\n  });'
);
fs.writeFileSync('src/App.tsx', appCode);

// Patch server.ts
let serverCode = fs.readFileSync('server.ts', 'utf8');
serverCode = serverCode.replace(
  '          investorConversations: 0,\n          partnerConversations: 0,\n        },',
  '          investorConversations: 0,\n          partnerConversations: 0,\n          projectedMonthlyRevenue: Math.floor(pipelineValue * 0.15),\n        },'
);
fs.writeFileSync('server.ts', serverCode);

