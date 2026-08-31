const fs = require('fs');

const code = `
import { db } from '../db/index';
import { contacts, accounts, conversations } from '../db/schema';
import { eq, or, ilike } from 'drizzle-orm';
import { ClientIdentityResolution } from '../../shared/domain/models';

export class IdentityResolverService {
  async resolve(emailAddress: string, organizationId: string): Promise<ClientIdentityResolution> {
    const emailStr = this.normalizeEmail(emailAddress);
    const domain = this.extractDomain(emailStr);

    let contactId: string | undefined;
    let accountId: string | undefined;
    let conversationId: string | undefined;
    let resolutionMethod: 'EXACT_EMAIL' | 'DOMAIN_MATCH' | 'NEW_CONTACT' = 'NEW_CONTACT';
    let confidence = 0;

    // 1. Exact Email Match
    const existingContacts = await db.select().from(contacts).where(
      eq(contacts.primaryEmail, emailStr)
    ).limit(1);

    if (existingContacts.length > 0) {
      contactId = existingContacts[0].id;
      accountId = existingContacts[0].accountId || undefined;
      resolutionMethod = 'EXACT_EMAIL';
      confidence = 1.0;
    } 
    // 2. Domain Match (excluding public domains)
    else if (!this.isPublicDomain(domain)) {
      const domainContacts = await db.select().from(contacts).where(
         ilike(contacts.primaryEmail, \`%@\${domain}\`)
      ).limit(1);
      
      if (domainContacts.length > 0) {
        // Assume same account
        accountId = domainContacts[0].accountId || undefined;
        resolutionMethod = 'DOMAIN_MATCH';
        confidence = 0.8;
      }
    }

    if (contactId) {
      // Find latest conversation
      const convs = await db.select().from(conversations).where(
         eq(conversations.contactId, contactId)
      ).limit(1);
      if (convs.length > 0) {
         conversationId = convs[0].id;
      }
    }

    return {
       isResolved: !!contactId,
       resolutionMethod,
       matchedLeadId: contactId,
       contactId,
       accountId,
       conversationId,
       confidence,
       provenance: \`DB match on \${resolutionMethod}\`,
       suggestedAction: 'PROCEED'
    };
  }

  private normalizeEmail(email: string) {
    const match = email.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase().trim() : email.toLowerCase().trim();
  }

  private extractDomain(email: string) {
    return email.split('@')[1] || '';
  }
  
  private isPublicDomain(domain: string) {
     const publicDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com'];
     return publicDomains.includes(domain);
  }
}
`;

fs.writeFileSync('server/services/identityResolver.service.ts', code);
console.log("Created real identityResolver.service.ts");
