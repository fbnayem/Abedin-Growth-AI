export interface RecipientContext {
  country: string;
  campaignType: string;
  consentGiven: boolean;
  isB2B: boolean;
}

export class OutreachPolicyService {
  // Q. JURISDICTION-AWARE OUTREACH POLICY
  async evaluateOutreach(context: RecipientContext): Promise<{ allowed: boolean, reason?: string }> {
     // GDPR / CAN-SPAM logic stub
     if (context.country === 'DE' && !context.consentGiven && !context.isB2B) {
        return { allowed: false, reason: 'Double opt-in required for DE B2C' };
     }
     
     if (context.country === 'CA' && !context.consentGiven && !context.isB2B) {
        return { allowed: false, reason: 'CASL requires explicit consent for CA B2C' };
     }

     return { allowed: true };
  }
}

export const outreachPolicyService = new OutreachPolicyService();
