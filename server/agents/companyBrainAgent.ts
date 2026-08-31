import { safeGenerateJSON } from "../geminiClient";
import { CompanyBrain } from "../../shared/domain/models";

export async function generateCompanyBrain(input: {
  companyName: string;
  companyUrl: string;
  productName: string;
  productUrl: string;
  targetMarkets: string[];
  primaryObjectives: string[];
  additionalNotes?: string;
}): Promise<CompanyBrain> {
  const fallbackBrain: CompanyBrain = {
    workspaceId: "default",
    companyName: input.companyName || "Abedin Tech",
    companyUrl: input.companyUrl || "https://abedintech.com/voice-ai/",
    productName: input.productName || "Abedin Voice AI",
    productUrl: input.productUrl || "https://abedintech.com/voice-ai/",
    tagline: "Autonomous 24/7 Conversational Voice AI for Enterprise & Appointment Businesses",
    description: "Abedin Voice AI replaces missed calls and inefficient phone operations with ultra-low latency, human-grade conversational voice agents that qualify leads, schedule appointments, handle customer queries, and integrate with your CRM.",
    targetIndustries: [
      "Dental & Healthcare Clinics",
      "Real Estate & Property Management",
      "Automotive Dealerships & Service Centers",
      "Legal & Financial Consultancies",
      "Home Services & Contracting",
      "B2B SaaS & Tech Support",
    ],
    targetCountries: input.targetMarkets && input.targetMarkets.length > 0 ? input.targetMarkets : ["United Kingdom", "United States", "UAE", "Saudi Arabia", "Singapore"],
    customerProblems: [
      "Missed after-hours and peak-time inbound calls losing high-value customer leads",
      "High cost of staffing 24/7 human receptionists and receptionist turnover",
      "Slow speed-to-lead response when prospects fill online quote/booking forms",
      "Inconsistent call qualification and manual CRM data entry errors",
    ],
    coreFeatures: [
      "Sub-500ms voice response latency for natural, uninterrupted phone conversations",
      "Direct Google Calendar & CRM 2-way real-time appointment booking",
      "Autonomous multi-turn lead qualification & custom question branch logic",
      "Warm call transfer to live human specialists when escalation criteria are met",
      "Automatic call transcript generation, intent analysis, and sentiment tagging",
    ],
    primaryBenefits: [
      "Zero missed calls: 100% answer rate 24/7/365",
      "3.4x faster lead response time increasing demo/booking conversion rates by 42%",
      "Over 65% reduction in front-desk reception overhead costs",
      "Seamless sync into existing scheduling tools and enterprise databases",
    ],
    differentiators: [
      "Domain-tuned conversational nuance preventing robotic turn-taking pauses",
      "Deterministic business policy engine guaranteeing zero pricing hallucinations",
      "Omnichannel handoff: Voice to SMS / WhatsApp confirmation within seconds",
    ],
    targetPersonas: [
      {
        title: "Clinic Practice Manager / Owner",
        department: "Operations",
        painPoint: "Front desk staff overwhelmed with scheduling calls during peak patient visit hours.",
      },
      {
        title: "Head of Sales / Business Development",
        department: "Revenue",
        painPoint: "High drop-off rate on web inbound inquiries due to delayed callback times.",
      },
      {
        title: "Managing Director / Partner",
        department: "Executive",
        painPoint: "High personnel expenditure with limited weekend and after-hours coverage.",
      },
    ],
    customerUseCases: [
      {
        industry: "Dental & Medical Clinics",
        useCase: "24/7 inbound appointment booking, rescheduling, and cancellation handling directly into dental practice management software.",
        expectedROI: "Recovers £18,000+ per month in previously missed new patient consultations.",
      },
      {
        industry: "Real Estate Agencies",
        useCase: "Instant callback and qualification of property buyer/renter inquiries from portal listings, booking viewings on agent calendars.",
        expectedROI: "Triples viewing confirmations and eliminates weekend phone coverage gaps.",
      },
    ],
    salesAngles: [
      "The Missed Opportunity Angle: Calculate how many thousands in revenue are lost every weekend from unreturned calls.",
      "The Speed-to-Lead Angle: Contact inbound leads within 15 seconds while their purchase intent is peak.",
      "The Overhead Reducer Angle: Provide 24/7 call center tier performance at 20% of the cost of a single full-time hire.",
    ],
    objectionsAndAnswers: [
      {
        objection: "Will our customers know it is AI and get frustrated?",
        recommendedResponse: "Abedin Voice AI operates with natural cadence, sub-500ms latency, and polite conversational manners. In tests, over 88% of callers complete their booking smoothly without hesitation, and any complex edge case is instantly transferred to your live team.",
      },
      {
        objection: "How difficult is it to integrate with our current calendar/software?",
        recommendedResponse: "Setup takes under 15 minutes with native calendar syncing (Google Calendar, Outlook) and direct webhook connections to leading industry CRM tools.",
      },
    ],
    investorNarrative: {
      vision: "Pioneering the global transition from static IVR phone trees and expensive human call centers to intelligent, autonomous voice agent infrastructure for SMBs and mid-market enterprises.",
      marketOpportunity: "$48B global conversational AI and voice operations market growing at 28% CAGR.",
      moat: "Proprietary low-latency conversational orchestration, verticalized workflow models, and sticky calendar/CRM integration layer.",
      tractionHighlights: "Rapidly expanding in UK dental, European property, and Gulf enterprise sectors with high retention and rapid payback period.",
    },
    partnerNarrative: {
      partnerValueProposition: "Enable marketing agencies, telecom providers, and CRM consultants to offer turnkey 24/7 AI voice receptionist solutions to their client base with high margin recurring SaaS revenue.",
      revenueSharingModel: "25% to 35% recurring monthly revenue share on all managed client subscriptions.",
      idealPartnerProfile: "Dental marketing agencies, estate agency software consultants, BPO contact center operators, and regional VoIP/telecom resellers.",
    },
    updatedAt: new Date().toISOString(),
  };

  const prompt = `
You are the Senior SaaS Growth Architect and Product Strategist for "${input.companyName}" (Product: "${input.productName}").
Website: ${input.companyUrl} | Product URL: ${input.productUrl}
Target Markets: ${input.targetMarkets.join(", ")}
Primary Objectives: ${input.primaryObjectives.join(", ")}
Additional Context: ${input.additionalNotes || "Autonomous conversational Voice AI for appointments, customer qualification, 24/7 inbound calls, and multi-industry outbound workflows."}

Generate an exhaustive, highly strategic "Company Brain" knowledge model in JSON format.
Return ONLY valid JSON matching this exact structure:
{
  "companyName": "${input.companyName}",
  "companyUrl": "${input.companyUrl}",
  "productName": "${input.productName}",
  "productUrl": "${input.productUrl}",
  "tagline": "string",
  "description": "string",
  "targetIndustries": ["string"],
  "targetCountries": ${JSON.stringify(input.targetMarkets)},
  "customerProblems": ["string"],
  "coreFeatures": ["string"],
  "primaryBenefits": ["string"],
  "differentiators": ["string"],
  "targetPersonas": [
    {
      "title": "string",
      "department": "string",
      "painPoint": "string"
    }
  ],
  "customerUseCases": [
    {
      "industry": "string",
      "useCase": "string",
      "expectedROI": "string"
    }
  ],
  "salesAngles": ["string"],
  "objectionsAndAnswers": [
    {
      "objection": "string",
      "recommendedResponse": "string"
    }
  ],
  "investorNarrative": {
    "vision": "string",
    "marketOpportunity": "string",
    "moat": "string",
    "tractionHighlights": "string"
  },
  "partnerNarrative": {
    "partnerValueProposition": "string",
    "revenueSharingModel": "string",
    "idealPartnerProfile": "string"
  }
}
`;

  const parsed = await safeGenerateJSON<CompanyBrain>({
    prompt,
    category: "SMART",
    temperature: 0.3,
    fallbackData: fallbackBrain,
    agentName: "companyBrainAgent",
  });

  return {
    workspaceId: "default",
    ...parsed,
    updatedAt: new Date().toISOString(),
  };
}
