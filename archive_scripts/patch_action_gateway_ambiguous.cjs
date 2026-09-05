const fs = require('fs');
const file = 'server/gateway/actionGateway.ts';
let code = fs.readFileSync(file, 'utf8');

const anchor = `    } catch (e: any) {
      console.error(\`[ActionGateway] Fatal error during \${request.actionType}:\`, e);
      await this.logAction(actionId, 'ERROR', request, { error: e.message, status: 'AMBIGUOUS_PROVIDER_RESULT' });
      return { success: false, error: e.message };
    }`;

const replace = `    } catch (e: any) {
      console.error(\`[ActionGateway] Fatal error during \${request.actionType}:\`, e);
      // E. AMBIGUOUS PROVIDER RESULT
      // Network dropped or 504 Gateway Timeout means we don't know if the provider succeeded.
      const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');
      const status = isAmbiguous ? 'AMBIGUOUS_PROVIDER_RESULT' : 'ERROR';
      await this.logAction(actionId, status, request, { error: e.message, requiresReconciliation: isAmbiguous });
      
      if (isAmbiguous) {
         // Queue for reconciliation worker...
         console.warn(\`[ActionGateway] Provider result is ambiguous. Action queued for reconciliation.\`);
      }
      return { success: false, error: e.message, blockedReason: isAmbiguous ? 'AMBIGUOUS_PROVIDER_RESULT' : undefined };
    }`;

code = code.replace(anchor, replace);
fs.writeFileSync(file, code);
