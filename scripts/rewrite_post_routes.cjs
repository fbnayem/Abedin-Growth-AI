const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf8');

// The grep hasn't returned yet but let's rewrite the POST routes generically by inserting into db
// We need to see exactly what they do.
