const fs = require('fs');
let code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');

const lines = code.split('\n');
const newLines = lines.map(line => {
    if (line.includes('isResolved:')) return '       isResolved: !!contactId as any,';
    if (line.includes('resolutionMethod:')) return '       resolutionMethod: resolutionMethod as any,';
    return line;
});

fs.writeFileSync('server/services/identityResolver.service.ts', newLines.join('\n'));
