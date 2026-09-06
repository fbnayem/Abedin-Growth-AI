import { db } from '../db/index';
import { contacts, accounts, conversations } from '../db/schema';
import { and, eq, ilike, isNull } from 'drizzle-orm';
import { ClientIdentityResolution } from '../../shared/domain/models';
import { normalizeEmailKey, PUBLIC_EMAIL_DOMAINS } from '../lib/identity';

/**
 * P1.5 — RESOLVING AN INBOUND ADDRESS TO A CONTACT (addendum §29, §18).
 *
 * Three things were wrong here, and the first is the one that made the rest moot.
 *
 * 1. THE LOOKUP BYPASSED THE NORMALISATION IT DEPENDS ON. The exact-match query compared
 *    `contacts.primary_email` with `eq`, while uniqueness is enforced on `email_key`. So the
 *    stored key was normalised and the lookup was not: an inbound `Alice@Example.COM` did not
 *    match a stored `alice@example.com`, resolved to no contact, and the message was dropped
 *    by the caller's `if (!identity.contactId) return`. This is exactly the defect the shared
 *    key was written to fix, still live on the read side.
 *
 * 2. THE DOMAIN PATTERN WAS BUILT FROM AN UNTRUSTED HEADER. `ilike(primaryEmail, '%@' + domain)`
 *    where `domain` came from splitting the `From` header. `%` and `_` are LIKE wildcards, so
 *    a sender whose address ends `@%` produced the pattern `%@%` — matching the first contact
 *    in the tenant and handing the sender that contact's account. A hostname cannot contain
 *    either character, so the fix is to require the domain to look like one (§18: material
 *    from outside must not gain authority, including over a query).
 *
 * 3. THE RETURN VALUE DID NOT MATCH ITS DECLARED TYPE. It was cast `as any` and returned
 *    `isResolved`, `matchedLeadId`, `confidence` and `suggestedAction` — none of which are on
 *    `ClientIdentityResolution`, which declares `identityConfidence`, `email`, `name`,
 *    `company` and `domain`. Any caller reading the declared fields got undefined, and the
 *    cast is what stopped the compiler saying so.
 */

/** A hostname: letters, digits, dots and hyphens. Notably NOT `%` or `_`. */
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export class IdentityResolverService {
  /**
   * P1.1 — `organizationId` was a parameter this method accepted and never used. Every query
   * below ran across the entire contacts and conversations tables, so an inbound email from
   * a person who exists in ANOTHER tenant resolved to that tenant's contact, and the reply
   * was composed against their history. All three queries now carry the tenant predicate.
   */
  async resolve(emailAddress: string, organizationId: string): Promise<ClientIdentityResolution> {
    const emailKey = normalizeEmailKey(emailAddress);
    const domain = emailKey === null ? '' : emailKey.slice(emailKey.indexOf('@') + 1);

    const unresolved = (reason: string): ClientIdentityResolution => ({
      email: emailKey ?? '',
      name: '',
      company: '',
      domain,
      identityConfidence: 0,
      resolutionMethod: 'UNRESOLVED_NEW',
      sourceProvenance: reason,
    });

    // An address that cannot be normalised has no identity key, and guessing one would mean
    // every unparseable sender resolving to the same contact.
    if (emailKey === null) {
      return unresolved(`Address ${JSON.stringify(emailAddress)} could not be normalised.`);
    }

    // 1. Exact match, on the SAME key the uniqueness constraint uses.
    //
    // `supersededBy IS NULL` excludes records that have been merged away. Without it a lookup
    // could resolve to a record marked MERGED, whose conversations now live on the survivor —
    // so the composer would draft against an empty history for a customer who has one.
    const existingContacts = await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.organizationId, organizationId),
          eq(contacts.emailKey, emailKey),
          isNull(contacts.supersededBy)
        )
      )
      .limit(1);

    if (existingContacts.length > 0) {
      const contact = existingContacts[0];
      const conversationId = await this.latestConversationId(organizationId, contact.id);
      return {
        contactId: contact.id,
        leadId: contact.id,
        companyId: contact.accountId ?? undefined,
        conversationId,
        email: emailKey,
        name: contact.name ?? [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        company: '',
        jobTitle: contact.title ?? undefined,
        domain,
        identityConfidence: 1.0,
        resolutionMethod: 'EXACT_EMAIL',
        sourceProvenance: `Matched contacts.email_key within organisation ${organizationId}.`,
      } as ClientIdentityResolution;
    }

    // 2. Domain match, which identifies the COMPANY and never the person.
    //
    // A match here must not set contactId: knowing that someone else at the same company is a
    // contact does not tell us who this is, and treating it as identity would attribute an
    // inbound message to a colleague and reply into their thread.
    if (!PUBLIC_EMAIL_DOMAINS.has(domain) && DOMAIN_PATTERN.test(domain)) {
      const domainContacts = await db
        .select()
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, organizationId),
            ilike(contacts.primaryEmail, `%@${domain}`),
            isNull(contacts.supersededBy)
          )
        )
        .limit(1);

      if (domainContacts.length > 0) {
        return {
          companyId: domainContacts[0].accountId ?? undefined,
          email: emailKey,
          name: '',
          company: domain,
          domain,
          identityConfidence: 0.5,
          resolutionMethod: 'DOMAIN_MATCH',
          sourceProvenance:
            `No contact with this address; another contact shares the domain ${domain}. ` +
            'Company identified, person NOT identified.',
        } as ClientIdentityResolution;
      }
    }

    return unresolved(`No contact in organisation ${organizationId} matches ${emailKey}.`);
  }

  private async latestConversationId(
    organizationId: string,
    contactId: string
  ): Promise<string | undefined> {
    const rows = await db
      .select()
      .from(conversations)
      .where(
        and(eq(conversations.organizationId, organizationId), eq(conversations.contactId, contactId))
      )
      .orderBy(conversations.lastMessageAt)
      .limit(1);
    return rows.length > 0 ? rows[0].id : undefined;
  }
}
