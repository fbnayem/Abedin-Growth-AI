const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// Ah, toFixed() is being called on a number or 0. Wait, 0.toFixed() doesn't work if it's evaluated incorrectly? No, (0).toFixed(1) works.
// Let's look closely at line 224:
// Conversion Rate ({(camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100).toFixed(1)}%) is below threshold ({thresholds[camp.id]}%)
// Wait, the ternary is missing the false branch!
// (camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100)
// It's missing : 0
// It should be: (camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0).toFixed(1)

const badLine = '                          Conversion Rate ({(camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100).toFixed(1)}%) is below threshold ({thresholds[camp.id]}%)';
const goodLine = '                          Conversion Rate ({((camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0)).toFixed(1)}%) is below threshold ({thresholds[camp.id]}%)';

code = code.replace(badLine, goodLine);
fs.writeFileSync('src/pages/CampaignsView.tsx', code);
