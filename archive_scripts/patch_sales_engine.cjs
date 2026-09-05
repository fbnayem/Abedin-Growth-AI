const fs = require('fs');
const file = 'server/agents/salesDecisionEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const importStr = `import { CALENDAR_BOOKING_URL, GOOGLE_MEET_URL, WEBSITE_URL, ONBOARDING_URL } from "./trustedCtaRegistry";`;
const newImportStr = `import { CALENDAR_BOOKING_URL, GOOGLE_MEET_URL, WEBSITE_URL, ONBOARDING_URL } from "./trustedCtaRegistry";\nimport { aiSecurityService } from '../services/aiSecurity.service';\nimport { ledgerService } from '../services/ledgers.service';`;
code = code.replace(importStr, newImportStr);

const fnAnchor = `export async function composeAutonomousSalesReply(input: {
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  buyingStage: BuyingStage;
  rawInboundText: string;
  threadHistory?: EmailMessage[];
}): Promise<{ subject: string; body: string; replyPlan: ReplyPlan }> {`;

const fnReplace = `export async function composeAutonomousSalesReply(input: {
  identity: ClientIdentityResolution;
  emailUnderstanding: EmailUnderstanding;
  nextBestAction: NextBestActionResult;
  buyingStage: BuyingStage;
  rawInboundText: string;
  threadHistory?: EmailMessage[];
}): Promise<{ subject: string; body: string; replyPlan: ReplyPlan }> {
  // S. AI SECURITY / RED TEAM TESTS
  if (aiSecurityService.detectPromptInjection(input.rawInboundText)) {
      console.warn("[AiSecurity] Prompt injection detected in inbound text. Suppressing response.");
      return {
          subject: "",
          body: "",
          replyPlan: {
              contact: { name: input.identity.name, company: input.identity.company, email: input.identity.email },
              product: "Abedin Voice AI",
              primaryIntent: "SUPPRESS",
              secondaryIntents: [],
              buyingStage: input.buyingStage,
              purchaseReadiness: 0,
              meetingReadiness: 0,
              questionsToAnswer: [],
              knownRelevantFacts: [],
              objections: [],
              missingInformation: [],
              specialistsRequired: [],
              nextBestAction: "SUPPRESS",
              sendBookingLink: false,
              sendOnboardingLink: false,
              reason: "Security suppression due to prompt injection signature."
          }
      };
  }
  
  // F. FACT FRESHNESS & K. QUOTE SNAPSHOT
  // Here we would typically fetch the dynamic ledger facts to inject them into the prompt.
  // const orgId = "org_1"; // Mock
  // const quotes = await ledgerService.getQuotes(orgId, input.identity.email); // stub method
  
`;
code = code.replace(fnAnchor, fnReplace);

fs.writeFileSync(file, code);
