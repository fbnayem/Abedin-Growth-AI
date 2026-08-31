import { safeGenerateJSON, extractArray } from "../geminiClient";
import { Investor, CompanyBrain } from "../../shared/domain/models";

export async function scoreAndResearchInvestor(
  investorInput: Partial<Investor>,
  companyBrain?: CompanyBrain
): Promise<Partial<Investor>> {
  const fallbackData = {
    investorFitScore: 89,
    thesisMatchReason: "Strong mandate in early-stage vertical AI and enterprise software automation.",
    portfolioFitExample: "Portfolio contains complementary B2B SMB platforms and appointment infrastructure.",
    recommendedPitchAngle: "Position Abedin Voice AI as the autonomous conversational voice infrastructure layer.",
    sensitiveRestrictions: [
      "Valuation and cap table specifics require direct founder conversation",
    ],
  };

  const prompt = `
You are the Senior Investor Relations & Venture Architect for ${companyBrain?.companyName || "Abedin Tech"}.
Company Vision & Moat:
${companyBrain?.investorNarrative?.vision || "Autonomous Voice AI replacing legacy IVR and call centers"}
Market Opportunity: ${companyBrain?.investorNarrative?.marketOpportunity || "$48B Global conversational AI market"}

Investor / Fund to Analyze:
Name: ${investorInput.name || "Partner"}
Fund Name: ${investorInput.fundName || "SaaS Ventures"}
Role: ${investorInput.role || "Partner"}
Country: ${investorInput.country || "Singapore"}
Stage: ${investorInput.stage || "SEED"}
Target Sectors: ${(investorInput.targetSectors || ["B2B SaaS", "AI Infrastructure", "Enterprise Automation"]).join(", ")}

Analyze this investor's thesis alignment, portfolio synergies, check size fit, and compute:
1. Investor Fit Score (0-100)
2. Thesis Match Reason (specific, grounded)
3. Portfolio Fit Example / Synergies
4. Recommended Pitch Angle (tailored to their fund philosophy)
5. Sensitive Restrictions (strictly list items NOT to speculate about, e.g. unverified ARR/valuation without founder)

Return ONLY valid JSON matching this exact structure:
{
  "investorFitScore": 92,
  "thesisMatchReason": "Strong focus on applied AI replacing repetitive operational workflows in service economies with high retention metrics.",
  "portfolioFitExample": "Fund has previously backed CRM and vertical SaaS tools, creating immediate cross-sell distribution potential.",
  "recommendedPitchAngle": "Frame Abedin Voice AI as the definitive voice-first agent layer for service businesses with sticky calendar/booking lock-in.",
  "sensitiveRestrictions": [
    "Do not quote fixed pre-money valuation without founder authorization",
    "Only share audited ARR benchmarks approved in Knowledge Base"
  ]
}
`;

  const data = await safeGenerateJSON<{
    investorFitScore?: number;
    thesisMatchReason?: string;
    portfolioFitExample?: string;
    recommendedPitchAngle?: string;
    sensitiveRestrictions?: string[];
  }>({
    prompt,
    category: "SMART",
    temperature: 0.2,
    fallbackData,
    agentName: "investorAgent",
  });

  return {
    ...investorInput,
    investorFitScore: data.investorFitScore ?? fallbackData.investorFitScore,
    thesisMatchReason: data.thesisMatchReason || fallbackData.thesisMatchReason,
    portfolioFitExample: data.portfolioFitExample || fallbackData.portfolioFitExample,
    recommendedPitchAngle: data.recommendedPitchAngle || fallbackData.recommendedPitchAngle,
    sensitiveRestrictions: data.sensitiveRestrictions || fallbackData.sensitiveRestrictions,
    lastContactAt: new Date().toISOString(),
  };
}

export async function batchDiscoverInvestors(options: {
  stage?: string;
  sectors?: string[];
  location?: string;
  count?: number;
  excludeNames?: string[];
  companyBrain?: CompanyBrain;
}): Promise<Investor[]> {
  const { stage = "SEED", sectors = ["Applied AI", "B2B SaaS", "Automation"], location = "Global", count = 4, excludeNames = [], companyBrain } = options;

  const prompt = `
You are the Venture Capital & Investor Discovery AI for ${companyBrain?.companyName || "Abedin Tech"}.
Company Narrative: ${companyBrain?.investorNarrative?.vision || "Autonomous Voice AI infrastructure powering service economy booking"}
Market Opportunity: ${companyBrain?.investorNarrative?.marketOpportunity || "$48B Global conversational AI market"}

Discover and construct ${count} realistic, active Venture Capital funds or prominent Angel investors matching:
Stage: ${stage}
Target Sectors: ${sectors.join(", ")}
Target Region / Hub: ${location}

Do NOT return any of these already existing fund or investor names:
${excludeNames.slice(0, 30).join(", ") || "None"}

Generate realistic Fund names, lead Partner names, roles, typical check sizes, investment thesis alignments, portfolio synergies, and tailored pitch angles.

Return ONLY a valid JSON array of objects with this exact structure:
[
  {
    "name": "Marcus Vance",
    "fundName": "Horizon Frontier Ventures",
    "role": "General Partner",
    "email": "m.vance@horizonfrontiervc.com",
    "linkedinUrl": "https://linkedin.com/in/marcusvance-vc",
    "country": "${location.includes("Global") ? "Singapore" : location}",
    "stage": "${stage}",
    "typicalCheckSize": "$750K - $1.5M",
    "targetSectors": ${JSON.stringify(sectors)},
    "investorFitScore": 93,
    "thesisMatchReason": "Aggressive deployment into verticalized generative AI tools that directly generate revenue for SMBs and enterprise service providers.",
    "portfolioFitExample": "Backed multiple workflow automation and CRM platforms in Asia-Pacific and EMEA.",
    "recommendedPitchAngle": "Emphasize rapid customer payback, stickiness of direct calendar synchronization, and defensibility of voice agent datasets.",
    "sensitiveRestrictions": [
      "Require founder approval for cap table disclosures and valuation terms",
      "Do not provide non-public ARR milestones without audited data"
    ]
  }
]
`;

  // Dynamic fallback generator
  const fallbackList: Investor[] = [];
  const fundPrefixes = ["Apex", "Valence", "Nexus", "TrueScale", "Kinetics", "Frontier", "Vertex", "Hyperion", "Redwood", "Catalyst", "Pioneer", "Equinox", "Foundry", "Signal"];
  const fundSuffixes = ["Ventures", "Capital", "Fund", "Partners", "Seed Fund", "Venture Partners", "Horizon"];
  const partnerNames = [
    { name: "Alexander Wright", role: "General Partner" },
    { name: "Priya Sundaram", role: "Founding Partner" },
    { name: "Julian Chen", role: "Partner, AI & Enterprise" },
    { name: "Camilla Frost", role: "Managing Director" },
    { name: "David Sterling", role: "Venture Partner" },
    { name: "Nadia Al-Hassan", role: "General Partner" },
    { name: "Liam O'Connor", role: "Principal" },
    { name: "Elena Rostova", role: "Partner" },
  ];
  const hubs = ["Singapore", "United Kingdom", "United States", "Germany", "United Arab Emirates", "France", "Canada"];

  for (let i = 0; i < count; i++) {
    const timestamp = Date.now() + i;
    const p = partnerNames[(i * 3 + Math.floor(Math.random() * 3)) % partnerNames.length];
    const prefix = fundPrefixes[(i * 2 + Math.floor(Math.random() * 4)) % fundPrefixes.length];
    const suffix = fundSuffixes[(i + Math.floor(Math.random() * 3)) % fundSuffixes.length];
    const fund = `${prefix} ${suffix}`;
    const domain = fund.toLowerCase().replace(/[^a-z0-9]/g, "") + ".vc";
    const loc = location === "Global" ? hubs[i % hubs.length] : location;

    fallbackList.push({
      id: `inv_gen_${timestamp}_${i}`,
      workspaceId: "default",
      name: p.name,
      fundName: fund,
      role: p.role,
      email: `${p.name.split(" ")[0].toLowerCase()}@${domain}`,
      linkedinUrl: `https://linkedin.com/in/${p.name.toLowerCase().replace(" ", "")}-vc`,
      country: loc,
      stage: stage as any,
      typicalCheckSize: stage === "PRE_SEED" ? "$250K - $500K" : stage === "SEED" ? "$500K - $1.5M" : "$2M - $5M",
      targetSectors: sectors,
      investorFitScore: 89 + (i % 8),
      status: "DISCOVERED",
      thesisMatchReason: `High-conviction mandate targeting ${sectors.slice(0, 2).join(" and ")} with scalable B2B recurring revenue.`,
      portfolioFitExample: `Active portfolio investments in customer operations and workflow automation in ${loc}.`,
      recommendedPitchAngle: "Position Abedin Voice AI as the autonomous agent infrastructure that captures lost revenue for service businesses.",
      sensitiveRestrictions: [
        "Founder presence required for final valuation discussion",
        "Disclose customer metrics according to official verified data room"
      ],
      lastContactAt: new Date().toISOString(),
    });
  }

  const generated = await safeGenerateJSON<any>({
    prompt,
    category: "SMART",
    temperature: 0.3,
    fallbackData: fallbackList,
    agentName: "investorAgent.batchDiscover",
  });

  const arrayData = extractArray(generated) || fallbackList;

  if (Array.isArray(arrayData) && arrayData.length > 0) {
    return arrayData.map((item, idx) => {
      const fallbackItem = fallbackList[idx % fallbackList.length] || fallbackList[0];
      return {
        id: item.id && !item.id.includes("demo") ? item.id : `inv_ai_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
        workspaceId: "default",
        name: item.name || fallbackItem.name,
        fundName: item.fundName || fallbackItem.fundName,
        role: item.role || fallbackItem.role,
        email: item.email || fallbackItem.email,
        linkedinUrl: item.linkedinUrl || fallbackItem.linkedinUrl,
        country: item.country || fallbackItem.country || (location === "Global" ? "Singapore" : location),
        stage: (item.stage || stage) as any,
        typicalCheckSize: item.typicalCheckSize || fallbackItem.typicalCheckSize,
        targetSectors: item.targetSectors && item.targetSectors.length > 0 ? item.targetSectors : sectors,
        investorFitScore: typeof item.investorFitScore === "number" ? item.investorFitScore : (fallbackItem.investorFitScore || 92),
        status: (item.status as any) || "DISCOVERED",
        thesisMatchReason: item.thesisMatchReason || fallbackItem.thesisMatchReason,
        portfolioFitExample: item.portfolioFitExample || fallbackItem.portfolioFitExample,
        recommendedPitchAngle: item.recommendedPitchAngle || fallbackItem.recommendedPitchAngle,
        sensitiveRestrictions: item.sensitiveRestrictions || fallbackItem.sensitiveRestrictions,
        lastContactAt: new Date().toISOString(),
      };
    });
  }

  return fallbackList;
}

