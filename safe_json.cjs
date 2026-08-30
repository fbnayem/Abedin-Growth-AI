const fs = require('fs');

let content = fs.readFileSync('src/App.tsx', 'utf8');

// We need to replace all instances of:
// const foo = await barRes.json(); 
// with a safe check, but that's hard to regex. 

// Actually, we can just replace `await xxx.json()` with `(xxx.headers.get("content-type")?.includes("application/json") ? await xxx.json() : null)`
// Let's do a regex replace for `await (\\w+)\.json\(\)` -> `($1.headers.get("content-type")?.includes("application/json") ? await $1.json() : null)`
// Wait, then we would be assigning null to things. Is that safe? 
// If `data` is null, `setAutopilotStatus(data)` might crash if it expects an object.
