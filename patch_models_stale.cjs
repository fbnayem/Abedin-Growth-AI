const fs = require('fs');
let code = fs.readFileSync('shared/domain/models.ts', 'utf8');

code = code.replace(
  '  autoCheckQualityControl?: boolean;',
  '  autoCheckQualityControl?: boolean;\n  autoReengageStaleLeads?: boolean;'
);

fs.writeFileSync('shared/domain/models.ts', code);
