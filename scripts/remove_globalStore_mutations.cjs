const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf8');

// The plan is to remove all globalStore mutations from routes if they already insert into PostgreSQL.
// It looks like `globalStore.saveToDisk()` is the main trigger.

// Let's replace the lines matching `globalStore.entity.unshift` or `.push` or `saveToDisk` inside API routes.
const patterns = [
    /globalStore\.leads\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.investors\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.partners\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.campaigns\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.opportunities\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.meetings\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
    /globalStore\.conversations\.unshift\(.*?\);\n\s*globalStore\.saveToDisk\(\);/g,
];

patterns.forEach(p => {
    server = server.replace(p, '');
});

fs.writeFileSync('server.ts', server);
console.log("Removed globalStore array unshifts/saveToDisk in server.ts");
