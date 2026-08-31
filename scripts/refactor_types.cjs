const fs = require('fs');

// We merged types.ts and models.ts into shared/domain/models.ts
let combined = fs.readFileSync('shared/domain/models.ts', 'utf8');

fs.writeFileSync('shared/domain/models.ts', combined);
fs.writeFileSync('src/types.ts', "export * from '../shared/domain/models';\n");

console.log("Updated src/types.ts to export from shared/domain/models");
