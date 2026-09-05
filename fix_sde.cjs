const fs = require('fs');
let code = fs.readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');

code = code.replace(
    "import { ledgerService } from '../services/ledgers.service';",
    "import { LedgerService } from '../services/ledgers.service';\nconst ledgerService = new LedgerService();"
);

fs.writeFileSync('server/agents/salesDecisionEngine.ts', code);
