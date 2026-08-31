const fs = require('fs');

if (!fs.existsSync('shared')) fs.mkdirSync('shared');
if (!fs.existsSync('shared/domain')) fs.mkdirSync('shared/domain');

fs.copyFileSync('server/domain/models.ts', 'shared/domain/models.ts');
console.log('Copied server/domain/models.ts to shared/domain/models.ts');
