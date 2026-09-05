const fs = require('fs');
let code = fs.readFileSync('server/services/identityResolver.service.ts', 'utf8');

code = code.replace(
    'return { \n       isResolved: !!contactId as any,\n       resolutionMethod: resolutionMethod as any,\n       matchedLeadId: contactId,\n       contactId,\n       accountId,\n       conversationId,\n       confidence,\n       domain\n    };',
    'return { \n       isResolved: !!contactId,\n       resolutionMethod: resolutionMethod as any,\n       matchedLeadId: contactId,\n       contactId,\n       accountId,\n       conversationId,\n       confidence,\n       domain\n    } as any;'
);

fs.writeFileSync('server/services/identityResolver.service.ts', code);
