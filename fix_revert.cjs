const fs = require('fs');
let code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');

code = code.replace(
    '       resolutionMethod: resolutionMethod as any,\n    let confidence = 0;',
    '    let resolutionMethod: "EXACT_EMAIL" | "DOMAIN_MATCH" | "NEW_CONTACT" | "UNRESOLVED_NEW" = "NEW_CONTACT" as any;\n    let confidence = 0;'
);

fs.writeFileSync('server/services/identityResolver.service.ts', code);
