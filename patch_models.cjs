const fs = require('fs');
let code = fs.readFileSync('shared/domain/models.ts', 'utf8');
code = code.replace(
  '  aiStrategySummary: string;',
  '  aiStrategySummary: string;\n  isABTestingEnabled?: boolean;'
);
fs.writeFileSync('shared/domain/models.ts', code);
