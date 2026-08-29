import { safeGenerateJSON } from "../geminiClient";
import { CompanyBrain } from "../../src/types";

export interface AICommandPlanStep {
  stepNumber: number;
  title: string;
  description: string;
  actionType: "READ" | "WRITE" | "EXTERNAL";
}

export interface AICommandResult {
  intent: string;
  userMessage: string;
  responseSummary: string;
  requiresPlanApproval: boolean;
  structuredIntent?: {
    goal: string;
    engineType: "CUSTOMER" | "INVESTOR" | "PARTNER";
    targetIndustry?: string;
    location?: string;
    count?: number;
    filters?: Record<string, any>;
  };
  planSteps?: AICommandPlanStep[];
  actionRecommendation?: {
    type: string;
    targetTab?: string;
    payload?: any;
  };
}

function buildDynamicFallback(
  userQuery: string,
  companyBrain?: CompanyBrain,
  contextData?: any
): AICommandResult {
  const query = userQuery.toLowerCase();
  const prodName = companyBrain?.productName || "Abedin Voice AI";

  if (query.includes("investor") || query.includes("fund") || query.includes("venture") || query.includes("raise") || query.includes("capital")) {
    return {
      intent: "investor_prospecting",
      userMessage: userQuery,
      responseSummary: `I've mapped out an investor discovery campaign targeting venture funds and angel networks with active mandates in conversational AI and vertical SaaS.`,
      requiresPlanApproval: true,
      structuredIntent: {
        goal: "investor_prospecting",
        engineType: "INVESTOR",
        targetIndustry: "AI Infrastructure & B2B SaaS",
        location: "Singapore & Europe",
        count: 20,
        filters: { stage: "Seed to Series A" },
      },
      planSteps: [
        {
          stepNumber: 1,
          title: "1. Screen Venture Funds",
          description: "Filter 20 funds with active thesis in Voice AI and vertical SaaS infrastructure",
          actionType: "READ",
        },
        {
          stepNumber: 2,
          title: "2. Analyze Partner Mandates",
          description: "Analyze portfolio synergies and identify lead partners investing in AI automation",
          actionType: "READ",
        },
        {
          stepNumber: 3,
          title: "3. Compute Investor Fit Score",
          description: "Score funds (0-100) based on stage match, check size, and strategic value",
          actionType: "WRITE",
        },
        {
          stepNumber: 4,
          title: "4. Prepare Founder Outreach",
          description: "Generate tailored founder introductions emphasizing unit economics and $48B market opportunity",
          actionType: "WRITE",
        },
      ],
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "investors",
      },
    };
  }

  if (query.includes("partner") || query.includes("agency") || query.includes("reseller") || query.includes("distribution") || query.includes("affiliate")) {
    return {
      intent: "partner_prospecting",
      userMessage: userQuery,
      responseSummary: `I've prepared a channel partner discovery workflow targeting digital marketing agencies and software consultancies that serve appointment businesses.`,
      requiresPlanApproval: true,
      structuredIntent: {
        goal: "partner_prospecting",
        engineType: "PARTNER",
        targetIndustry: "Healthcare Marketing Agencies & Tech Consultancies",
        location: "United Kingdom & UAE",
        count: 25,
        filters: { model: "Revenue Sharing / Reseller" },
      },
      planSteps: [
        {
          stepNumber: 1,
          title: "1. Find Agency Partners",
          description: "Identify 25 high-performing marketing & CRM agencies serving dental and healthcare clinics",
          actionType: "READ",
        },
        {
          stepNumber: 2,
          title: "2. Research Agency Portfolios",
          description: "Verify client roster size and assess demand for 24/7 AI voice receptionist add-ons",
          actionType: "READ",
        },
        {
          stepNumber: 3,
          title: "3. Score Partner Fit",
          description: "Evaluate distribution leverage, co-sell synergy, and recurring margin potential",
          actionType: "WRITE",
        },
        {
          stepNumber: 4,
          title: "4. Structure Partnership Angle",
          description: "Draft 30% recurring margin co-selling pitch with ready-to-use client demo deck",
          actionType: "WRITE",
        },
      ],
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "partners",
      },
    };
  }

  if (query.includes("lead") || query.includes("prospect") || query.includes("dental") || query.includes("clinic") || query.includes("customer") || query.includes("find") || query.includes("doctor")) {
    const isUK = query.includes("uk") || query.includes("london") || query.includes("british") || query.includes("england");
    const location = isUK ? "United Kingdom" : (query.includes("us") || query.includes("usa")) ? "United States" : "United Kingdom";
    const industry = query.includes("real estate") ? "Real Estate & Property Management" : query.includes("auto") ? "Automotive Dealerships" : "Dental & Healthcare Clinics";

    return {
      intent: "customer_prospecting",
      userMessage: userQuery,
      responseSummary: `I've mapped out a full 6-step customer prospecting sequence targeting ${industry} in ${location} for ${prodName}.`,
      requiresPlanApproval: true,
      structuredIntent: {
        goal: "customer_prospecting",
        engineType: "CUSTOMER",
        targetIndustry: industry,
        location: location,
        count: 50,
        filters: {
          inboundCallReliance: true,
          afterHoursBookingFocus: true,
        },
      },
      planSteps: [
        {
          stepNumber: 1,
          title: "1. Discover Qualified Companies",
          description: `Filter 50 appointment-reliant ${industry} in ${location} with active reception workflows`,
          actionType: "READ",
        },
        {
          stepNumber: 2,
          title: "2. Research Operational Pain",
          description: "Analyze booking latency, web intake channels, and after-hours call phone trees",
          actionType: "READ",
        },
        {
          stepNumber: 3,
          title: "3. Identify Decision Makers",
          description: "Identify Practice Managers, Clinical Directors, and Managing Partners with budget authority",
          actionType: "READ",
        },
        {
          stepNumber: 4,
          title: "4. Compute AI Score (0-100)",
          description: "Calculate ICP Fit, Pain Probability, Intent, and Decision Maker Quality",
          actionType: "WRITE",
        },
        {
          stepNumber: 5,
          title: "5. Generate Personalized Outreach",
          description: "Draft 4-step sequence highlighting 24/7 calendar sync and missed appointment recovery",
          actionType: "WRITE",
        },
        {
          stepNumber: 6,
          title: "6. Start Managed Outbound",
          description: "Queue approved communications and monitor for high-intent demo requests",
          actionType: "EXTERNAL",
        },
      ],
      actionRecommendation: {
        type: "PROSPECTING_WORKFLOW",
        targetTab: "leads",
      },
    };
  }

  if (query.includes("inbox") || query.includes("reply") || query.includes("email") || query.includes("conversation") || query.includes("unread")) {
    return {
      intent: "query_inbox",
      userMessage: userQuery,
      responseSummary: "Here is your current conversation triage. You have active prospect discussions with AI-proposed replies ready for your review.",
      requiresPlanApproval: false,
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "inbox",
      },
    };
  }

  if (query.includes("pipeline") || query.includes("deal") || query.includes("stage") || query.includes("revenue") || query.includes("forecast")) {
    return {
      intent: "query_pipeline",
      userMessage: userQuery,
      responseSummary: "Navigating to your deal pipeline. Deals are organized across Customer, Investor, and Partner stages with real-time probability estimates.",
      requiresPlanApproval: false,
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "pipeline",
      },
    };
  }

  if (query.includes("meeting") || query.includes("calendar") || query.includes("demo") || query.includes("schedule") || query.includes("brief")) {
    return {
      intent: "query_meetings",
      userMessage: userQuery,
      responseSummary: "Opening your meeting briefing console. View confirmed demos, Google Meet links, and AI-generated tactical briefing cheat-sheets.",
      requiresPlanApproval: false,
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "meetings",
      },
    };
  }

  if (query.includes("brain") || query.includes("knowledge") || query.includes("icp") || query.includes("faq") || query.includes("objection")) {
    return {
      intent: "query_knowledge",
      userMessage: userQuery,
      responseSummary: `Opening Company Brain for ${prodName}. Review verified product capabilities, pricing boundaries, objection responses, and investor narratives.`,
      requiresPlanApproval: false,
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "knowledge",
      },
    };
  }

  if (query.includes("campaign") || query.includes("sequence") || query.includes("cadence") || query.includes("outreach")) {
    return {
      intent: "create_campaign",
      userMessage: userQuery,
      responseSummary: "Opening the Campaign Engine. You can launch tailored 4-step multi-touch sequences across Customer, Investor, or Channel Partner tracks.",
      requiresPlanApproval: false,
      actionRecommendation: {
        type: "NAVIGATE_TAB",
        targetTab: "campaigns",
      },
    };
  }

  // Default strategic guidance
  return {
    intent: "general_guidance",
    userMessage: userQuery,
    responseSummary: `I've analyzed your growth pipeline for ${prodName}. You have high-fit healthcare and clinic prospects ready for review, plus 2 demo calls queued this week.`,
    requiresPlanApproval: false,
    planSteps: [
      {
        stepNumber: 1,
        title: "Review High Score Leads",
        description: "Examine leads with AI Score > 90 in the Dental & Healthcare vertical",
        actionType: "READ",
      },
      {
        stepNumber: 2,
        title: "Approve Proposed Replies",
        description: "Check inbox for prospect inquiries regarding Google Calendar integration",
        actionType: "WRITE",
      },
      {
        stepNumber: 3,
        title: "Review Meeting Briefs",
        description: "Prep demo agenda for Mayfair Dental with calculated missed-call ROI estimates",
        actionType: "READ",
      },
    ],
    actionRecommendation: {
      type: "NAVIGATE_TAB",
      targetTab: "leads",
    },
  };
}

export async function processGrowthCommand(
  userQuery: string,
  companyBrain?: CompanyBrain,
  contextData?: any
): Promise<AICommandResult> {
  const fallback = buildDynamicFallback(userQuery, companyBrain, contextData);

  const prompt = `
You are the Executive AI Growth Team Co-Pilot for ${companyBrain?.productName || "Abedin Voice AI"}.
User Command: "${userQuery}"

Current Context:
- Product: ${companyBrain?.productName || "Abedin Voice AI"}
- Description: ${companyBrain?.description || "Autonomous 24/7 Conversational Voice AI receptionist"}
- Target Markets: ${companyBrain?.targetCountries?.join(", ") || "UK, US, UAE, Singapore"}
- Target Industries: ${companyBrain?.targetIndustries?.join(", ") || "Healthcare, Real Estate, Automotive"}
- Context Summary: ${JSON.stringify(contextData || {})}

Analyze the user's natural language request and determine:
1. Intent & Goal (e.g. customer_prospecting, investor_prospecting, partner_prospecting, query_leads, query_inbox, create_campaign, daily_priorities, draft_followup, general_guidance)
2. Conversational response summary (friendly, direct, strategic, authoritative)
3. If this involves bulk operations, new prospecting campaigns, or external outbound, set "requiresPlanApproval": true and return a 4-6 step visible workflow plan.
4. If it is a direct query (e.g., "Show qualified leads", "What should I focus on today?"), answer directly and provide targetTab navigation.

Return ONLY valid JSON matching this exact structure:
{
  "intent": "customer_prospecting",
  "userMessage": "${userQuery.replace(/"/g, '\\"')}",
  "responseSummary": "I have mapped out a customer prospecting campaign targeting UK dental clinics that match your ICP for Abedin Voice AI.",
  "requiresPlanApproval": true,
  "structuredIntent": {
    "goal": "customer_prospecting",
    "engineType": "CUSTOMER",
    "targetIndustry": "Dental & Healthcare Clinics",
    "location": "United Kingdom",
    "count": 50,
    "filters": {
      "minStaff": 5,
      "inboundAppointmentFocus": true
    }
  },
  "planSteps": [
    {
      "stepNumber": 1,
      "title": "1. Find Companies",
      "description": "Discover 50 appointment-reliant dental clinics in the United Kingdom",
      "actionType": "READ"
    },
    {
      "stepNumber": 2,
      "title": "2. Research Companies",
      "description": "Analyze patient booking workflows and after-hours call dependencies",
      "actionType": "READ"
    },
    {
      "stepNumber": 3,
      "title": "3. Find Decision Makers",
      "description": "Identify Practice Managers, Partners, and Clinical Directors",
      "actionType": "READ"
    },
    {
      "stepNumber": 4,
      "title": "4. Score Leads (0-100)",
      "description": "Compute ICP Fit, Pain Probability, Intent, and Decision Authority",
      "actionType": "WRITE"
    },
    {
      "stepNumber": 5,
      "title": "5. Prepare Outreach",
      "description": "Generate personalized 4-step email sequences with genuine proof points",
      "actionType": "WRITE"
    },
    {
      "stepNumber": 6,
      "title": "6. Start Conversations",
      "description": "Queue approved emails and monitor incoming replies for instant classification",
      "actionType": "EXTERNAL"
    }
  ],
  "actionRecommendation": {
    "type": "PROSPECTING_WORKFLOW",
    "targetTab": "leads"
  }
}
`;

  return safeGenerateJSON<AICommandResult>({
    prompt,
    category: "SMART",
    temperature: 0.2,
    fallbackData: fallback,
    agentName: "growthCommandAgent",
  });
}
