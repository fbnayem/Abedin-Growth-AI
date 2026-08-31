const fs = require('fs');
let schema = fs.readFileSync('server/db/schema.ts', 'utf8');

if (!schema.includes('unique().notNull()') && schema.includes('oauthConnections')) {
    // wait, instead of modifying the raw string which is hard, I will just append a unique index.
    // Or just manually update the record where organizationId and provider match instead of using onConflictDoUpdate.
}
