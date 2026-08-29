import { safeGenerateJSON, extractArray } from "../geminiClient";
import { Partner, CompanyBrain } from "../../src/types";

export async function scoreAndResearchPartner(
  partnerInput: Partial<Partner>,
  companyBrain?: CompanyBrain
): Promise<Partial<Partner>> {
  const fallbackData = {
    partnerFitScore: 87,
    potentialCollaboration: "Offer Abedin Voice AI to existing customer accounts seeking 24/7 appointment reception.",
    revenueModel: "30% monthly recurring commission per onboarded clinic/client.",
    targetDecisionMaker: "Managing Partner",
  };

  const prompt = `
You are the Strategic Partnerships & Ecosystem Director for ${companyBrain?.companyName || "Abedin Tech"}.
Partner Value Proposition: ${companyBrain?.partnerNarrative?.partnerValueProposition || "Provide turnkey 24/7 AI voice reception to clients"}
Revenue Sharing Model: ${companyBrain?.partnerNarrative?.revenueSharingModel || "25-35% recurring SaaS revenue share"}

Potential Partner to Evaluate:
Name: ${partnerInput.name || "Agency Lead"}
Company: ${partnerInput.companyName || "Digital Growth Agency"}
Partner Type: ${partnerInput.partnerType || "AGENCY"}
Role: ${partnerInput.role || "Managing Director"}
Country: ${partnerInput.country || "United Kingdom"}

Evaluate this partner's distribution power, client base synergy, and compute:
1. Partner Fit Score (0-100)
2. Potential Collaboration (concrete integration or co-selling workflow)
3. Revenue Model (suggested commercial structure)
4. Target Decision Maker (key internal stakeholder to align with)

Return ONLY valid JSON matching this exact structure:
{
  "partnerFitScore": 91,
  "potentialCollaboration": "Bundle Abedin Voice AI as an automated call-handling add-on for their existing 40+ healthcare and dental agency clients.",
  "revenueModel": "30% recurring monthly margin on all active client seats plus setup fee split.",
  "targetDecisionMaker": "Head of Client Services / Agency Co-Founder"
}
`;

  const data = await safeGenerateJSON<{
    partnerFitScore?: number;
    potentialCollaboration?: string;
    revenueModel?: string;
    targetDecisionMaker?: string;
  }>({
    prompt,
    category: "SMART",
    temperature: 0.2,
    fallbackData,
    agentName: "partnerAgent",
  });

  return {
    ...partnerInput,
    partnerFitScore: data.partnerFitScore ?? fallbackData.partnerFitScore,
    potentialCollaboration: data.potentialCollaboration || fallbackData.potentialCollaboration,
    revenueModel: data.revenueModel || fallbackData.revenueModel,
    targetDecisionMaker: data.targetDecisionMaker || fallbackData.targetDecisionMaker,
    lastContactAt: new Date().toISOString(),
  };
}

export async function batchDiscoverPartners(options: {
  partnerType?: string;
  territory?: string;
  count?: number;
  excludeNames?: string[];
  companyBrain?: CompanyBrain;
}): Promise<Partner[]> {
  const { partnerType = "AGENCY", territory = "United Kingdom", count = 4, excludeNames = [], companyBrain } = options;

  const prompt = `
You are the Strategic Channel Partner Discovery AI for ${companyBrain?.companyName || "Abedin Tech"}.
Partner Value Proposition: ${companyBrain?.partnerNarrative?.partnerValueProposition || "Turnkey 24/7 AI voice reception for agency clients with 30% recurring margin"}
Revenue Share Model: ${companyBrain?.partnerNarrative?.revenueSharingModel || "25-35% monthly recurring margin"}

Discover and construct ${count} realistic B2B channel partners matching:
Partner Type: ${partnerType} (e.g., Marketing Agency, Telecom Reseller, Healthcare CRM Consultant, BPO Provider)
Target Territory: ${territory}

Do NOT return any of these already existing partner names:
${excludeNames.slice(0, 30).join(", ") || "None"}

Generate realistic Agency/Partner company names, lead contacts, roles, collaboration potential, revenue models, and decision-maker alignments.

Return ONLY a valid JSON array of objects with this exact structure:
[
  {
    "name": "Marcus Holloway",
    "companyName": "Elevate Health Media",
    "partnerType": "${partnerType}",
    "role": "Managing Director",
    "email": "m.holloway@elevatehealthmedia.co.uk",
    "country": "${territory}",
    "partnerFitScore": 92,
    "potentialCollaboration": "Bundle Abedin Voice AI into their digital marketing retainer for 35+ private cosmetic and dental clinic clients to solve the lead conversion bottleneck.",
    "revenueModel": "30% recurring SaaS revenue share plus 50% split on client onboarding fees.",
    "targetDecisionMaker": "Head of Client Delivery & Managing Partner"
  }
]
`;

  // Dynamic fallback generator
  const fallbackList: Partner[] = [];
  const agencyPrefixes = ["Omni", "Vanguard", "Apex", "BluePrint", "Velocity", "Aura", "Catalyst", "Elevate", "ScalePoint", "MedGrowth", "PrimeEdge", "Pulse"];
  const agencySuffixes = ["Digital", "Media Group", "Agency", "Growth Partners", "Consulting", "Interactive", "Telecoms", "Solutions"];
  const contactNames = [
    { name: "Marcus Holloway", role: "Managing Director" },
    { name: "Siddharth Rao", role: "Founder & CEO" },
    { name: "Sophie Bennett", role: "Head of Agency Partnerships" },
    { name: "Oliver Davies", role: "Commercial Director" },
    { name: "Amira Mansoor", role: "Client Strategy Lead" },
    { name: "Lucas Laurent", role: "Managing Partner" },
  ];

  for (let i = 0; i < count; i++) {
    const timestamp = Date.now() + i;
    const c = contactNames[(i * 3 + Math.floor(Math.random() * 3)) % contactNames.length];
    const prefix = agencyPrefixes[(i * 2 + Math.floor(Math.random() * 4)) % agencyPrefixes.length];
    const suffix = agencySuffixes[(i + Math.floor(Math.random() * 3)) % agencySuffixes.length];
    const company = `${prefix} ${suffix}`;
    const domain = company.toLowerCase().replace(/[^a-z0-9]/g, "") + (territory.toLowerCase().includes("kingdom") || territory.toLowerCase().includes("uk") ? ".co.uk" : ".com");

    fallbackList.push({
      id: `part_gen_${timestamp}_${i}`,
      workspaceId: "default",
      name: c.name,
      companyName: company,
      partnerType: partnerType as any,
      role: c.role,
      email: `${c.name.split(" ")[0].toLowerCase()}@${domain}`,
      country: territory,
      partnerFitScore: 88 + (i % 8),
      status: "DISCOVERED",
      potentialCollaboration: `Introduce Abedin Voice AI as a managed 24/7 call receptionist add-on for their existing client roster in ${territory}.`,
      revenueModel: "30% recurring monthly margin on all active software seats plus onboarding fee split.",
      targetDecisionMaker: c.role,
      lastContactAt: new Date().toISOString(),
    });
  }

  const generated = await safeGenerateJSON<any>({
    prompt,
    category: "SMART",
    temperature: 0.3,
    fallbackData: fallbackList,
    agentName: "partnerAgent.batchDiscover",
  });

  const arrayData = extractArray(generated) || fallbackList;

  if (Array.isArray(arrayData) && arrayData.length > 0) {
    return arrayData.map((item, idx) => {
      const fallbackItem = fallbackList[idx % fallbackList.length] || fallbackList[0];
      return {
        id: item.id && !item.id.includes("demo") ? item.id : `part_ai_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
        workspaceId: "default",
        name: item.name || fallbackItem.name,
        companyName: item.companyName || fallbackItem.companyName,
        partnerType: (item.partnerType || partnerType) as any,
        role: item.role || fallbackItem.role,
        email: item.email || fallbackItem.email,
        country: item.country || fallbackItem.country || territory,
        partnerFitScore: typeof item.partnerFitScore === "number" ? item.partnerFitScore : (fallbackItem.partnerFitScore || 90),
        status: (item.status as any) || "DISCOVERED",
        potentialCollaboration: item.potentialCollaboration || fallbackItem.potentialCollaboration,
        revenueModel: item.revenueModel || fallbackItem.revenueModel,
        targetDecisionMaker: item.targetDecisionMaker || fallbackItem.targetDecisionMaker,
        lastContactAt: new Date().toISOString(),
      };
    });
  }

  return fallbackList;
}

