import { firestore } from '../firebase';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

export interface WorkflowBudget {
  maxAgentStepsPerReply: number;
  maxModelCallsPerReply: number;
  maxRetriesPerAgent: number;
  maxTokensPerReplyWorkflow: number;
  maxCostPerReply: number;
  maxDecisionLatency: number;
}

export const DEFAULT_BUDGET: WorkflowBudget = {
  maxAgentStepsPerReply: 5,
  maxModelCallsPerReply: 10,
  maxRetriesPerAgent: 3,
  maxTokensPerReplyWorkflow: 15000,
  maxCostPerReply: 0.50,
  maxDecisionLatency: 30000 // 30 seconds
};

export class AiSafetyService {
  
  // D. STALE DRAFT PROTECTION
  async checkStaleDraft(orgId: string, conversationId: string, draftVersionAtGeneration: number): Promise<boolean> {
    if (!firestore) return false;
    const convRef = doc(firestore, `organizations/${orgId}/conversations`, conversationId);
    const snap = await getDoc(convRef);
    if (!snap.exists()) return false;
    const currentVersion = snap.data().inboundMessageVersion || 0;
    
    // If newer inbound message arrived, invalidate draft
    return currentVersion > draftVersionAtGeneration;
  }

  // P. HUMAN OWNERSHIP LOCK
  async setHumanOwnershipLock(orgId: string, conversationId: string, isPaused: boolean) {
    if (!firestore) return;
    const convRef = doc(firestore, `organizations/${orgId}/conversations`, conversationId);
    await updateDoc(convRef, {
      autonomyPausedByHuman: isPaused,
      pausedAt: isPaused ? Date.now() : null
    });
  }
  
  // M. AI WORKFLOW BUDGETS
  async recordWorkflowUsage(orgId: string, conversationId: string, usage: { tokens?: number, steps?: number, calls?: number }) {
     // In a real implementation this would increment counters in a fast cache (e.g. Redis)
     // Here we simulate checking limits
     if ((usage.steps || 0) > DEFAULT_BUDGET.maxAgentStepsPerReply) {
       await this.setHumanOwnershipLock(orgId, conversationId, true);
       console.warn(`[AI Safety] Budget exceeded for steps. Falling back to human review.`);
       return false; // Budget exceeded
     }
     return true;
  }
}

export const aiSafetyService = new AiSafetyService();
