const fs = require('fs');
let code = fs.readFileSync('server/agents/independentAuditor.ts', 'utf8');

const importStr = "import { ClaimGroundingEngine } from '../policies/claimGrounding';\n";
if (!code.includes('ClaimGroundingEngine')) {
    code = importStr + code;
}

const groundingCheck = `
  // 11. Claim-Level Grounding (Part L)
  const groundingEngine = new ClaimGroundingEngine();
  const groundingResult = await groundingEngine.verifyClaims(sanitizedBody);
  if (!groundingResult.isGrounded) {
      score -= 30;
      issuesDetected.push(...groundingResult.ungroundedClaims);
  } else {
      checksPassed.push("All claims grounded in approved knowledge");
  }
`;

code = code.replace(
    /const finalDecision: AuditResult\["decision"\] =/g,
    function(match) {
        return groundingCheck + '\n  ' + match;
    }
);

code = code.replace(
    'export function auditReplyAgainstPlan(input',
    'export async function auditReplyAgainstPlan(input'
);

fs.writeFileSync('server/agents/independentAuditor.ts', code);

code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');
code = code.replace('const auditResult = auditReplyAgainstPlan(', 'const auditResult = await auditReplyAgainstPlan(');
fs.writeFileSync('server/services/inboundPipeline.ts', code);
