import { db } from '../db/index.ts';
import { contacts } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export class ContactRepository {
  async getContactByEmail(email: string) {
    try {
      const result = await db.select().from(contacts).where(eq(contacts.primaryEmail, email));
      return result.length > 0 ? result[0] : null;
    } catch(e) {
      return null;
    }
  }
}
export const contactRepository = new ContactRepository();
