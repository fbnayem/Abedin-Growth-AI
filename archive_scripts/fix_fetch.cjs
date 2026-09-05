const fs = require('fs');
const path = require('path');

function replaceFetchInFile(filePath) {
    if (filePath.includes('apiFetch.ts') || filePath.includes('diagnosticFetch.ts')) return;
    
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('fetch(') || content.includes('fetch (')) {
        // Add import
        // Determine relative path to src/lib/apiFetch
        const srcDir = path.resolve(__dirname, 'src');
        const fileDir = path.dirname(filePath);
        let relPath = path.relative(fileDir, path.join(srcDir, 'lib', 'apiFetch'));
        if (!relPath.startsWith('.')) relPath = './' + relPath;
        
        content = `import { apiFetch } from '${relPath}';\n` + content;
        
        // Replace fetch calls. Not global replace of "fetch", just function calls
        content = content.replace(/\bfetch\s*\(/g, 'apiFetch(');
        content = content.replace(/window\.fetch\s*\(/g, 'apiFetch(');
        
        fs.writeFileSync(filePath, content);
        console.log(`Updated ${filePath}`);
    }
}

function walk(dir) {
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walk(fullPath);
        } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
            replaceFetchInFile(fullPath);
        }
    }
}

walk(path.join(__dirname, 'src'));
