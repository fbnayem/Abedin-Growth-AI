import { Request, Response } from 'express';
import { circuitBreaker } from '../agents/salesDecisionEngine.ts';

export const killSwitchController = {
  toggleGlobal: (req: Request, res: Response) => {
    const { enabled, reason } = req.body;
    
    if (enabled === false) {
      // ENGAGE KILL SWITCH
      circuitBreaker.globalAutonomousSendEnabled = false;
      circuitBreaker.pausedReason = reason || "MANUAL_KILL_SWITCH_ENGAGED";
      console.warn(`[KILL SWITCH] Global outbound halted. Reason: ${circuitBreaker.pausedReason}`);
      
      // Attempt to cancel all pending outbox jobs
      // await db.update(outboxMessages).set({ status: 'CANCELLED' }).where(eq(status, 'PENDING'))
    } else {
      // DISENGAGE
      circuitBreaker.globalAutonomousSendEnabled = true;
      circuitBreaker.pausedReason = undefined;
      console.log(`[KILL SWITCH] Global outbound resumed.`);
    }

    res.json({
      success: true,
      globalAutonomousSendEnabled: circuitBreaker.globalAutonomousSendEnabled,
      reason: circuitBreaker.pausedReason
    });
  }
};
