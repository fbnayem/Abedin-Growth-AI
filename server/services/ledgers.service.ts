import { db } from '../db/index';
import { customerCommitments, questionLedger, objectionLedger, quoteSnapshots } from '../db/schema';
import { eq, and } from 'drizzle-orm';

export class LedgerService {
  async getUnresolvedCommitments(contactId: string) {
    if (!contactId) return [];
    return db.select().from(customerCommitments).where(
      and(
        eq(customerCommitments.contactId, contactId),
        eq(customerCommitments.status, 'UNRESOLVED')
      )
    );
  }

  async getOpenQuestions(conversationId: string) {
    if (!conversationId) return [];
    return db.select().from(questionLedger).where(
      and(
        eq(questionLedger.conversationId, conversationId),
        eq(questionLedger.status, 'OPEN')
      )
    );
  }

  async getUnresolvedObjections(conversationId: string) {
    if (!conversationId) return [];
    return db.select().from(objectionLedger).where(
      and(
        eq(objectionLedger.conversationId, conversationId),
        eq(objectionLedger.status, 'UNRESOLVED')
      )
    );
  }

  async getQuotes(contactId: string) {
    if (!contactId) return [];
    return db.select().from(quoteSnapshots).where(
      eq(quoteSnapshots.contactId, contactId)
    );
  }
}
