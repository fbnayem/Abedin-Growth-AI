const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  '<MeetingsView\n              meetings={meetings}',
  '<MeetingsView\n              companyBrain={companyBrain}\n              meetings={meetings}'
);

fs.writeFileSync('src/App.tsx', code);
