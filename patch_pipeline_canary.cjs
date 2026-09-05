const fs = require('fs');
let code = fs.readFileSync('server/services/inboundPipeline.ts', 'utf8');

const importStr = "import { CanaryRolloutService } from './canary.service';\n";
if (!code.includes('CanaryRolloutService')) {
    code = importStr + code;
}

const canaryLogic = `
      // --- W. CANARY AUTONOMY ---
      const canaryService = new CanaryRolloutService();
      // Only allow autonomous send if this account is part of the 50% canary rollout (configurable)
      const isAutonomousEnabled = canaryService.isFeatureEnabled('autonomous_dispatch', identity.accountId as string, 50);
      
      let finalPipelineAction = auditResult.decision;
      if (finalPipelineAction === 'PASS' && !isAutonomousEnabled) {
          console.warn('Account not in autonomous canary rollout. Downgrading PASS to ESCALATE for human review.');
          finalPipelineAction = 'ESCALATE';
      }
`;

code = code.replace(
    '      if (auditResult.decision === "PASS") {',
    canaryLogic + '\n      if (finalPipelineAction === "PASS") {'
);

code = code.replace(
    '      } else if (auditResult.decision === "ESCALATE") {',
    '      } else if (finalPipelineAction === "ESCALATE") {'
);

code = code.replace(
    '      } else if (auditResult.decision === "REWRITE") {',
    '      } else if (finalPipelineAction === "REWRITE") {'
);

code = code.replace(
    '      } else if (auditResult.decision === "BLOCK") {',
    '      } else if (finalPipelineAction === "BLOCK") {'
);


fs.writeFileSync('server/services/inboundPipeline.ts', code);
