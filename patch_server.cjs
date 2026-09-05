const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  'const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount } = req.body;',
  'const { name, engineType, targetAudience, targetIndustries, targetLocations, enrolledCount, isABTestingEnabled } = req.body;'
);

code = code.replace(
  'aiStrategySummary: `Generated custom sequence for ${targetAudience}. Leveraging local market context for ${(targetLocations || []).join(\', \')}.`,',
  'aiStrategySummary: `Generated custom sequence for ${targetAudience}. Leveraging local market context for ${(targetLocations || []).join(\', \')}. ${isABTestingEnabled ? "A/B Testing automatically configured across 2 variants." : ""}`,'
);

code = code.replace(
  'createdAt: new Date().toISOString()',
  'createdAt: new Date().toISOString(),\n        isABTestingEnabled: !!isABTestingEnabled'
);

fs.writeFileSync('server.ts', code);
