const fs = require('fs');
let code = fs.readFileSync('server.ts', 'utf8');

// We will find all `app.get`, `app.post`, `app.put` routes and remove those that mention globalStore.
const lines = code.split('\n');
let newLines = [];
let inRoute = false;
let routeLines = [];
let routeUsesGlobalStore = false;
let braceDepth = 0;

for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (!inRoute && (line.match(/^  app\.(get|post|put|delete)\("/) || line.match(/^app\.(get|post|put|delete)\("/))) {
        inRoute = true;
        routeLines = [];
        routeUsesGlobalStore = false;
        braceDepth = 0;
    }
    
    if (inRoute) {
        routeLines.push(line);
        if (line.includes('globalStore')) {
            routeUsesGlobalStore = true;
        }
        
        // simple brace counting
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth += opens - closes;
        
        // if braceDepth returns to 0 and we have a closing brace/paren/semicolon, route might be done
        // Actually, this simple counting might fail on strings/regexes. But it's usually fine for this file.
        if (braceDepth === 0 && line.trim().startsWith('});')) {
            inRoute = false;
            if (routeUsesGlobalStore) {
                // skip adding routeLines
            } else {
                newLines.push(...routeLines);
            }
        } else if (braceDepth <= 0 && line.trim() === '});') {
            inRoute = false;
             if (routeUsesGlobalStore) {
                // skip adding routeLines
            } else {
                newLines.push(...routeLines);
            }
        }
    } else {
        newLines.push(line);
    }
}

fs.writeFileSync('server.ts', newLines.join('\n'));
