import { firestore } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';

export interface CanaryConfig {
  enabledWorkspaces: string[];
  enabledMailboxes: string[];
  enabledCampaigns: string[];
  globalRolloutPercentage: number; // 0 to 100
}

export class CanaryService {
  // W. CANARY AUTONOMY
  async evaluateAutonomy(orgId: string, mailbox: string, campaignId?: string): Promise<boolean> {
    if (!firestore) return false;
    try {
      const configDoc = await getDoc(doc(firestore, `system/canaryConfig`));
      if (!configDoc.exists()) return false;
      
      const config = configDoc.data() as CanaryConfig;
      
      if (config.enabledWorkspaces.includes(orgId)) return true;
      if (config.enabledMailboxes.includes(mailbox)) return true;
      if (campaignId && config.enabledCampaigns.includes(campaignId)) return true;
      
      // Hash based percentage rollout
      if (config.globalRolloutPercentage > 0) {
        const hash = this.hashString(orgId + mailbox) % 100;
        if (hash < config.globalRolloutPercentage) return true;
      }
      
      return false;
    } catch (e) {
      console.error("Canary evaluation failed", e);
      return false; // Fail closed
    }
  }

  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0; 
    }
    return Math.abs(hash);
  }
}

export const canaryService = new CanaryService();
