import { ClientIdentityResolution, Lead, Conversation } from "../../src/types";
import { globalStore } from "../dataStore";

/**
 * Normalizes email address (lowercase, trim, strips trailing periods/brackets).
 */
export function normalizeEmail(email?: string): string {
  if (!email) return "";
  return email.trim().toLowerCase().replace(/[<>()[\]{}]/g, "");
}

/**
 * Extracts normalized root domain from email address (e.g. "nayem@dentalgroup.co.uk" -> "dentalgroup.co.uk").
 */
export function extractDomainFromEmail(email: string): string {
  const normalized = normalizeEmail(email);
  const parts = normalized.split("@");
  if (parts.length < 2) return "";
  const domain = parts[1].toLowerCase().trim();
  // Filter generic webmail domains so we don't accidentally match all gmail users to one company
  const genericWebmails = new Set([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "hotmail.com",
    "outlook.com",
    "icloud.com",
    "protonmail.com",
    "zoho.com",
    "aol.com",
    "live.com",
    "msn.com",
  ]);
  if (genericWebmails.has(domain)) {
    return "";
  }
  return domain;
}

/**
 * Resolves Client Identity from inbound sender info, linking to existing Lead, Conversation, or Campaign.
 */
export function resolveClientIdentity(input: {
  senderEmail: string;
  senderName?: string;
  subject?: string;
  existingConversationId?: string;
}): ClientIdentityResolution {
  const normalizedEmail = normalizeEmail(input.senderEmail);
  const domain = extractDomainFromEmail(normalizedEmail);

  // 1. Direct match by existing conversation ID
  if (input.existingConversationId) {
    const conv = globalStore.conversations.find((c) => c.id === input.existingConversationId);
    if (conv) {
      const matchedLead = conv.leadId ? globalStore.leads.find((l) => l.id === conv.leadId) : undefined;
      return {
        contactId: conv.id,
        leadId: conv.leadId || matchedLead?.id,
        companyId: matchedLead?.companyWebsite || domain || conv.companyName,
        campaignId: matchedLead?.assignedCampaignId,
        email: normalizedEmail || conv.contactEmail,
        name: input.senderName?.trim() || conv.contactName || matchedLead?.name || "Colleague",
        company: conv.companyName || matchedLead?.companyName || "Organization",
        jobTitle: conv.contactTitle || matchedLead?.title,
        domain: domain || extractDomainFromEmail(conv.contactEmail),
        identityConfidence: 0.98,
        resolutionMethod: "THREAD_CONTINUITY",
        sourceProvenance: `Conversation thread ${conv.id}`,
      };
    }
  }

  // 2. Exact match in Lead CRM database
  const leadByEmail = globalStore.leads.find(
    (l) => normalizeEmail(l.email) === normalizedEmail
  );
  if (leadByEmail) {
    return {
      contactId: leadByEmail.id,
      leadId: leadByEmail.id,
      companyId: leadByEmail.companyWebsite || domain || leadByEmail.companyName,
      campaignId: leadByEmail.assignedCampaignId,
      email: normalizedEmail,
      name: input.senderName?.trim() || leadByEmail.name,
      company: leadByEmail.companyName,
      jobTitle: leadByEmail.title,
      domain: domain || extractDomainFromEmail(leadByEmail.email),
      identityConfidence: 0.95,
      resolutionMethod: "EXACT_EMAIL",
      sourceProvenance: `Lead database record ID ${leadByEmail.id}`,
    };
  }

  // 3. Exact match in existing conversation list
  const convByEmail = globalStore.conversations.find(
    (c) => normalizeEmail(c.contactEmail) === normalizedEmail
  );
  if (convByEmail) {
    return {
      contactId: convByEmail.id,
      leadId: convByEmail.leadId,
      companyId: domain || convByEmail.companyName,
      email: normalizedEmail,
      name: input.senderName?.trim() || convByEmail.contactName,
      company: convByEmail.companyName,
      jobTitle: convByEmail.contactTitle,
      domain: domain || extractDomainFromEmail(convByEmail.contactEmail),
      identityConfidence: 0.92,
      resolutionMethod: "CRM_LOOKUP",
      sourceProvenance: `Historical conversation ${convByEmail.id}`,
    };
  }

  // 4. Domain match for corporate domain (not generic webmail)
  if (domain) {
    const leadByDomain = globalStore.leads.find(
      (l) => extractDomainFromEmail(l.email) === domain && l.companyName
    );
    if (leadByDomain) {
      return {
        contactId: undefined,
        leadId: leadByDomain.id,
        companyId: domain,
        campaignId: leadByDomain.assignedCampaignId,
        email: normalizedEmail,
        name: input.senderName?.trim() || "Colleague",
        company: leadByDomain.companyName,
        jobTitle: undefined,
        domain,
        identityConfidence: 0.78,
        resolutionMethod: "DOMAIN_MATCH",
        sourceProvenance: `Domain match to company ${leadByDomain.companyName}`,
      };
    }
  }

  // 5. Unresolved new contact fallback
  const fallbackName = input.senderName?.trim() || (normalizedEmail.split("@")[0] || "there");
  const fallbackCompany = domain ? domain.split(".")[0].toUpperCase() : "your team";

  return {
    email: normalizedEmail,
    name: fallbackName,
    company: fallbackCompany,
    domain,
    identityConfidence: 0.5,
    resolutionMethod: "UNRESOLVED_NEW",
    sourceProvenance: "Inbound sender header",
  };
}
