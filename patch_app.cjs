const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  '<LeadDetailModal\n        lead={activeLeadDetail}',
  '<LeadDetailModal\n        companyBrain={companyBrain}\n        lead={activeLeadDetail}'
);

fs.writeFileSync('src/App.tsx', code);
