const fs = require('fs');

// Fix types.ts (it complained "outbox" is not assignable to NavTab. That means my update_outbox_tab.cjs didn't work properly)
let types = fs.readFileSync('src/types.ts', 'utf8');
if (!types.includes('"outbox"')) {
    types = types.replace(/export type NavTab =([^;]+);/, (match, p1) => {
        return 'export type NavTab =' + p1 + ' | "outbox";';
    });
    fs.writeFileSync('src/types.ts', types);
}

