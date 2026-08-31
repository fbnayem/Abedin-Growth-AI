const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

code = code.replace("import { resolveClientIdentity } from '../agents/clientIdentityResolver';", "import { IdentityResolverService } from './identityResolver.service';");

code = code.replace(/const identity = resolveClientIdentity\([^;]+\); \/\/ mock args for now/, 
  "const identityService = new IdentityResolverService();\n      const identity = await identityService.resolve(email.from, organizationId);");

fs.writeFileSync('server/services/inboundPipeline.ts', code);
console.log("Updated inbound pipeline to use DB Identity Resolver");
