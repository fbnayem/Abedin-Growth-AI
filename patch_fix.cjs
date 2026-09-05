const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

code = code.replace(/<span className="text-\[10px\] font-bold text-slate-400 uppercase">Alert If </g, '<span className="text-[10px] font-bold text-slate-400 uppercase">Alert If &lt;</span>');

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
