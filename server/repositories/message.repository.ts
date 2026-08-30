import { db } from '../db/index.ts';
import { messages } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export class MessageRepository {
  async getMessagesForConversation(conversationId: string) {
    try {
      return await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    } catch (e) {
      return [];
    }
  }
}
export const messageRepository = new MessageRepository();
