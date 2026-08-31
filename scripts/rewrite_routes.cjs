const fs = require('fs');

let server = fs.readFileSync('server.ts', 'utf8');

// Replace the fallback arrays in existing replacements
server = server.replace(/res\.json\(\[\.\.\.mapped, \.\.\.globalStore\.investors\]\);/g, 'res.json(mapped);');
server = server.replace(/\} catch\(e\) \{ res\.json\(globalStore\.investors\); \}/g, '} catch(e) { console.error(e); res.status(500).json({error: e.message}); }');

server = server.replace(/res\.json\(\[\.\.\.mapped, \.\.\.globalStore\.partners\]\);/g, 'res.json(mapped);');
server = server.replace(/\} catch\(e\) \{ res\.json\(globalStore\.partners\); \}/g, '} catch(e) { console.error(e); res.status(500).json({error: e.message}); }');

server = server.replace(/res\.json\(\[\.\.\.mapped, \.\.\.globalStore\.meetings\]\);/g, 'res.json(mapped);');
server = server.replace(/\} catch\(e\) \{ res\.json\(globalStore\.meetings\); \}/g, '} catch(e) { console.error(e); res.status(500).json({error: e.message}); }');

server = server.replace(/res\.json\(\[\.\.\.mapped, \.\.\.globalStore\.campaigns\]\);/g, 'res.json(mapped);');
server = server.replace(/\} catch\(e\) \{ res\.json\(globalStore\.campaigns\); \}/g, '} catch(e) { console.error(e); res.status(500).json({error: e.message}); }');

server = server.replace(/res\.json\(\[\.\.\.mapped, \.\.\.globalStore\.opportunities\]\);/g, 'res.json(mapped);');
server = server.replace(/\} catch\(e\) \{ res\.json\(globalStore\.opportunities\); \}/g, '} catch(e) { console.error(e); res.status(500).json({error: e.message}); }');

// For leads
server = server.replace(/const legacyIds = new Set\(mappedLeads\.map\(l => l\.id\)\);\s*const legacyLeads = globalStore\.leads\.filter\(l => !legacyIds\.has\(l\.id\)\);\s*res\.json\(\[\.\.\.mappedLeads, \.\.\.legacyLeads\]\);/, 'res.json(mappedLeads);');
server = server.replace(/res\.json\(globalStore\.leads\); \/\/ fallback/, 'res.status(500).json({error: e.message});');

// For inbox
server = server.replace(/const legacyIds = new Set\(mappedConvs\.map\(c => c\.id\)\);\s*const legacy = globalStore\.conversations\.filter\(c => !legacyIds\.has\(c\.id\)\);\s*res\.json\(\[\.\.\.mappedConvs, \.\.\.legacy\]\);/, 'res.json(mappedConvs);');
server = server.replace(/res\.json\(globalStore\.conversations\);/, 'res.status(500).json({error: e.message});');

fs.writeFileSync('server.ts', server);
console.log("Routes cleaned of globalStore fallback reads");
