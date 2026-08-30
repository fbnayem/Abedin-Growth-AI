import { db } from '../db/index';
import { outboxMessages, messages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export interface OutboxPayload {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}

export class OutboxService {
  async queueMessage(conversationId: string, payload: OutboxPayload, idempotencyKey: string) {
    try {
      // In a real transactional system, this should be wrapped in db.transaction()
      // along with the application state updates (e.g. creating the 'DRAFT' message).
      
      const newOutbox = await db.insert(outboxMessages).values({
        id: uuidv4(),
        conversationId,
        idempotencyKey,
        payload,
        status: 'PENDING',
      }).returning();
      
      return newOutbox[0];
    } catch (error: any) {
      if (error.code === '23505') { // Unique violation
        console.log(`Idempotency key ${idempotencyKey} already exists. Skipping.`);
        return null;
      }
      throw error;
    }
  }

  async fetchPendingJobs(limit = 10) {
    try {
      return await db.select().from(outboxMessages)
        .where(eq(outboxMessages.status, 'PENDING'))
        .limit(limit);
    } catch (error) {
      console.error("Failed to fetch pending outbox jobs", error);
      return [];
    }
  }

  async markProcessed(id: string, providerMessageId: string) {
    await db.update(outboxMessages)
      .set({ status: 'PROCESSED', processedAt: new Date() })
      .where(eq(outboxMessages.id, id));
  }

  async markFailed(id: string, error: string) {
    await db.update(outboxMessages)
      .set({ status: 'FAILED', error })
      .where(eq(outboxMessages.id, id));
  }
}

export const outboxService = new OutboxService();
