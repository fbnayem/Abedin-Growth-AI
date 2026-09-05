const fs = require('fs');
let code = fs.readFileSync('server/services/ledgers.service.ts', 'utf8');
code = code.replace(
    'export class LedgerService {',
    'export class LedgerService {\n  async getQuotes(email: string): Promise<any[]> { return []; }'
);
fs.writeFileSync('server/services/ledgers.service.ts', code);
