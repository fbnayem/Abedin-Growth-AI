const fs = require('fs');
let code = fs.readFileSync('server/db/index.ts', 'utf8');

code = code.replace(
  'connectionString: config.dbUrl }',
  'connectionString: config.dbUrl, ssl: { rejectUnauthorized: false } }'
);

code = code.replace(
  'database: process.env.SQL_DB_NAME,',
  'database: process.env.SQL_DB_NAME, ssl: { rejectUnauthorized: false },'
);

fs.writeFileSync('server/db/index.ts', code);
console.log('Fixed server/db/index.ts SSL configuration');
