const fs = require('fs');
const file = 'server/gateway/actionGateway.ts';
let code = fs.readFileSync(file, 'utf8');

const importStr = `import { gmailService } from '../services/gmail.service';`;
const newImportStr = `import { gmailService } from '../services/gmail.service';\nimport { outreachPolicyService } from '../policies/outreachPolicy';`;
code = code.replace(importStr, newImportStr);

const executeAnchor = `  private async executeEmailSend(request: ActionRequest): Promise<ActionResult> {
    console.log(\`[ActionGateway] Executing EMAIL_SEND to \${request.payload.to}\`);
    try {`;

const executeReplace = `  private async executeEmailSend(request: ActionRequest): Promise<ActionResult> {
    console.log(\`[ActionGateway] Executing EMAIL_SEND to \${request.payload.to}\`);
    try {
        // Q. JURISDICTION-AWARE OUTREACH POLICY
        // In a real implementation, we'd lookup the recipient's country and consent status from the DB.
        const policyResult = await outreachPolicyService.evaluateOutreach({ 
            country: 'US', // Stub
            campaignType: 'inbound', 
            consentGiven: true, // Stub
            isB2B: true 
        });
        if (!policyResult.allowed) {
            console.warn(\`[ActionGateway] Email blocked by outreach policy: \${policyResult.reason}\`);
            return { success: false, blockedReason: policyResult.reason };
        }
`;
code = code.replace(executeAnchor, executeReplace);

fs.writeFileSync(file, code);
