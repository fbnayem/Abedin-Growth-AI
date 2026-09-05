const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

code = code.replace(
  /<input\s+type="text"\s+value=\{name\}/g,
  '<input type="text" placeholder="e.g. Q3 UK Dental Recovery" value={name}'
);

code = code.replace(
  /<input\s+type="text"\s+value=\{targetAudience\}/g,
  '<input type="text" placeholder="e.g. Practice Managers, Founders" value={targetAudience}'
);

code = code.replace(
  /<input\s+type="text"\s+value=\{locations\}/g,
  '<input type="text" placeholder="e.g. London, Manchester, UK" value={locations}'
);

code = code.replace(
  /<input\s+type="text"\s+value=\{industries\}/g,
  '<input type="text" placeholder="e.g. Healthcare, Tech" value={industries}'
);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
