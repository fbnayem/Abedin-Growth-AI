import { db } from '../db/index.ts';
import { conversations, messages, contacts } from '../db/schema.ts';
import { eq } from 'drizzle-orm';
import { globalStore } from '../../server/dataStore.ts'; // Fallback to memory store

export class ConversationRepository {
  async getConversationById(id: string) {
    try {
      // Attempt to load from PostgreSQL
      const convs = await db.select().from(conversations).where(eq(conversations.id, id));
      if (convs && convs.length > 0) return convs[0];
    } catch (error) {
      // Fallback if Postgres isn't configured/connected
      const legacyConv = globalStore.conversations.find((c) => c.id === id);
      if (legacyConv) {
        return {
          id: legacyConv.id,
          contactEmail: legacyConv.contactEmail,
          contactName: legacyConv.contactName,
          status: legacyConv.status,
          category: legacyConv.category,
          thread: legacyConv.thread,
        };
      }
    }
    return null;
  }

  async saveLegacyMessage(conversationId: string, message: any) {
    const conv = globalStore.conversations.find(c => c.id === conversationId);
    if (conv) {
      conv.thread.push(message);
      globalStore.saveToDisk();
    }
  }
}

export const conversationRepository = new ConversationRepository();
