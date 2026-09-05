const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

const oldLine = '                     (camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0) < thresholds[camp.id] && (';
const newLine = '                     ((camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0) < thresholds[camp.id]) && (';
code = code.replace(oldLine, newLine);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
