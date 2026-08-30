import { db } from '../db/index';
import { outboxMessages, contacts } from '../db/schema';
import { eq, or } from 'drizzle-orm';

export class SuppressionService {
  async checkSuppression(email: string): Promise<boolean> {
    if (!email) return false;
    
    // In a full implementation, we query a suppression_list table
    // For now, we fallback to memory store until DB is fully seeded
    return global.suppressionList?.includes(email) || false;
  }

  async addSuppression(email: string, reason: string) {
    if (!email) return;
    
    console.log(`[SUPPRESSION] Added ${email} to suppression list. Reason: ${reason}`);
    if (global.suppressionList) {
      if (!global.suppressionList.includes(email)) {
        global.suppressionList.push(email);
      }
    } else {
      global.suppressionList = [email];
    }

    // Attempt to update contact status if DB is connected
    try {
      await db.update(contacts)
        .set({ status: 'SUPPRESSED' })
        .where(eq(contacts.primaryEmail, email));
    } catch (e) {
      // Ignore DB error if not configured
    }
  }

  async processUnsubscribe(email: string) {
    await this.addSuppression(email, 'UNSUBSCRIBE_REQUEST');
    
    // Attempt to cancel pending outbox messages
    try {
      // We would ideally join outboxMessages with conversations -> contacts
      // to find messages to this email and mark them CANCELLED.
      // This is a stub for the logic.
    } catch (e) {}
  }
}

declare global {
  var suppressionList: string[];
}
if (!global.suppressionList) {
  global.suppressionList = [];
}

export const suppressionService = new SuppressionService();
