const fs = require('fs');

const dataStoreFile = 'server/dataStore.ts';
let dsCode = fs.readFileSync(dataStoreFile, 'utf8');

// Strip out duplicate DB definitions at the top of dataStore that I mistakenly pasted earlier
const anchorToRemove = `import { db } from "../server/db/index";
import { eq } from "drizzle-orm";
import { organizations, users, accounts, contacts, conversations, messages, conversationFacts, outboxMessages, campaigns, meetings, opportunities, knowledgeItems, attentionItems, aiRunLogs } from "../server/db/schema";

import { db } from "../server/db/index";
import { eq } from "drizzle-orm";
import { organizations, users, accounts, contacts, conversations, messages, conversationFacts, outboxMessages, campaigns, meetings, opportunities, knowledgeItems, attentionItems, aiRunLogs } from "../server/db/schema";
`;

dsCode = dsCode.replace(anchorToRemove, "");
fs.writeFileSync(dataStoreFile, dsCode);
console.log("Fixed duplicate imports in dataStore");
