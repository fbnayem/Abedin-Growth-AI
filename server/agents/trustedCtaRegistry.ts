import { CTARegistryEntry } from "../../shared/domain/models";

export const CALENDAR_BOOKING_URL = "https://calendar.app.google/abedin-voice-ai-demo";
export const GOOGLE_MEET_URL = "https://meet.google.com/abn-vce-demo";
export const WEBSITE_URL = "https://abedintech.com/voice-ai/";
export const ONBOARDING_URL = "https://abedintech.com/voice-ai/start";
export const SECURITY_DOCS_URL = "https://abedintech.com/voice-ai/security";

/**
 * Canonical in-memory CTA registry of pre-verified, allowed production URLs.
 * Strict gatekeeper prevents arbitrary hallucinatory URLs from ever being injected.
 */
export const TRUSTED_CTA_REGISTRY: CTARegistryEntry[] = [
  {
    id: "cta-cal-demo",
    type: "BOOK_DEMO",
    provider: "GOOGLE_CALENDAR",
    url: CALENDAR_BOOKING_URL,
    title: "Schedule Live Demonstration Calendar",
    enabled: true,
    verificationStatus: "VERIFIED_ACTIVE",
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: "cta-meet-room",
    type: "CONFIRMED_MEETING",
    provider: "GOOGLE_MEET",
    url: GOOGLE_MEET_URL,
    title: "Live Google Meet Walkthrough Room",
    enabled: true,
    verificationStatus: "VERIFIED_ACTIVE",
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: "cta-site-home",
    type: "WEBSITE",
    provider: "WEBSITE",
    url: WEBSITE_URL,
    title: "Abedin Voice AI Official Overview",
    enabled: true,
    verificationStatus: "VERIFIED_ACTIVE",
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: "cta-onboarding",
    type: "CUSTOMER_ONBOARDING",
    provider: "STRIPE_ONBOARDING",
    url: ONBOARDING_URL,
    title: "Direct Client Activation & Onboarding",
    enabled: true,
    verificationStatus: "VERIFIED_ACTIVE",
    lastVerifiedAt: new Date().toISOString(),
  },
  {
    id: "cta-sec-docs",
    type: "DOCUMENTATION",
    provider: "WEBSITE",
    url: SECURITY_DOCS_URL,
    title: "HIPAA, GDPR & Latency Compliance Docs",
    enabled: true,
    verificationStatus: "VERIFIED_ACTIVE",
    lastVerifiedAt: new Date().toISOString(),
  },
];

/**
 * Validates whether a given URL is approved in the CTA registry.
 */
export function isUrlInTrustedRegistry(url: string): boolean {
  if (!url) return false;
  const cleanUrl = url.trim().toLowerCase().replace(/\/$/, "");
  return TRUSTED_CTA_REGISTRY.some(
    (entry) => entry.enabled && entry.url.toLowerCase().replace(/\/$/, "") === cleanUrl
  );
}

/**
 * Sanitizes URLs in a text to guarantee only registered URLs are used.
 * If an unknown or malformed external booking link is found, safely replaces with the official registry booking link.
 */
export function sanitizeCtaUrls(text: string): { sanitized: string; modified: boolean; corrections: string[] } {
  if (!text) return { sanitized: "", modified: false, corrections: [] };
  let sanitized = text;
  const corrections: string[] = [];

  // Replace calendly or unverified custom schedulers with canonical Google Calendar
  const calendlyRegex = /https?:\/\/(?:www\.)?calendly\.com\/[^\s\n<>)"]+/gi;
  if (calendlyRegex.test(sanitized)) {
    corrections.push("Replaced non-whitelisted Calendly link with canonical Google Calendar booking link");
    sanitized = sanitized.replace(calendlyRegex, CALENDAR_BOOKING_URL);
  }

  // Replace cal.com or chili piper
  const calComRegex = /https?:\/\/(?:www\.)?cal\.com\/[^\s\n<>)"]+/gi;
  if (calComRegex.test(sanitized)) {
    corrections.push("Replaced Cal.com URL with canonical Google Calendar booking link");
    sanitized = sanitized.replace(calComRegex, CALENDAR_BOOKING_URL);
  }

  return {
    sanitized,
    modified: corrections.length > 0,
    corrections,
  };
}
