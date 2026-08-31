const fs = require('fs');

const agents = ['server/agents/clientIdentityResolver.ts', 'server/agents/multiAgentReplySystem.ts', 'server/agents/salesDecisionEngine.ts', 'server/agents/conversationMemoryAgent.ts', 'server/agents/inboxAgent.ts'];

agents.forEach(agent => {
   if (fs.existsSync(agent)) {
       let code = fs.readFileSync(agent, 'utf8');
       if (code.includes('globalStore')) {
           code = code.replace(/import \{ globalStore \} from "..\/dataStore";\n?/, '');
           code = code.replace(/import \{ globalStore \} from '..\/dataStore';\n?/, '');
           fs.writeFileSync(agent, code);
           console.log(\`Removed globalStore import from \${agent}\`);
       }
   }
});
