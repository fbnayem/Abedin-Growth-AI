const fs = require('fs');
let server = fs.readFileSync('server.ts', 'utf8');

const endpoints = ["/api/leads", "/api/investors", "/api/partners", "/api/campaigns", "/api/opportunities", "/api/meetings"];

endpoints.forEach(ep => {
    const idx = server.indexOf(`app.post("${ep}"`);
    if (idx !== -1) {
        const snippet = server.substring(idx, idx + 400);
        console.log(`--- ${ep} ---`);
        console.log(snippet.includes('db.insert') ? "Has db.insert" : "MISSING db.insert");
    } else {
        console.log(`--- ${ep} NOT FOUND ---`);
    }
});
