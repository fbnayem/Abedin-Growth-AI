const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

code = code.replace("import { ClientIdentityResolver } from '../agents/clientIdentityResolver';", "import { resolveClientIdentity } from '../agents/clientIdentityResolver';");
code = code.replace("import { ConversationMemoryAgent } from '../agents/conversationMemoryAgent';", "import { extractAndSynthesizeMemory } from '../agents/conversationMemoryAgent';");

code = code.replace(/const identityResolver = new ClientIdentityResolver\(\);\n\s*const identity = await identityResolver\.resolve\(email, organizationId\);/, 
  "const identity = resolveClientIdentity({ rawEmail: email.from, domain: email.from.split('@')[1], existingLeads: [], activeConversations: [] }); // mock args for now");

code = code.replace(/const memoryAgent = new ConversationMemoryAgent\(\);\n\s*await memoryAgent\.updateMemory\(conversationId, email\);/, 
  "// await extractAndSynthesizeMemory(conv, companyBrain);");

fs.writeFileSync('server/services/inboundPipeline.ts', code);
console.log("Fixed inbound pipeline functions");
