import { db } from '../db/index';
import { contacts, conversations, messages, conversationFacts } from '../db/schema';
import { eq } from 'drizzle-orm';

export class PrivacyService {
  async anonymizeContact(contactId: string) {
    // 1. Overwrite PII in contacts
    await db.update(contacts).set({
      firstName: 'ANONYMIZED',
      lastName: 'ANONYMIZED',
      name: 'ANONYMIZED',
      primaryEmail: `anonymized_${contactId}@deleted.local`,
      phone: null,
      linkedinUrl: null,
      status: 'ANONYMIZED'
    }).where(eq(contacts.id, contactId));

    // 2. Clear out facts and messages that might contain PII
    // For a strict approach, we delete them, or scrub them via LLM.
    const userConversations = await db.select().from(conversations).where(eq(conversations.contactId, contactId));
    for (const conv of userConversations) {
        await db.delete(conversationFacts).where(eq(conversationFacts.conversationId, conv.id));
        await db.update(messages).set({
            textBody: '[REDACTED DUE TO PRIVACY REQUEST]',
            rawHtmlBody: '[REDACTED DUE TO PRIVACY REQUEST]',
            htmlAsText: '[REDACTED DUE TO PRIVACY REQUEST]'
        }).where(eq(messages.conversationId, conv.id));
    }
    return true;
  }

  async exportContactData(contactId: string) {
    const contact = await db.select().from(contacts).where(eq(contacts.id, contactId));
    const convs = await db.select().from(conversations).where(eq(conversations.contactId, contactId));
    return {
        contact: contact[0] || null,
        conversations: convs
    };
  }
}
