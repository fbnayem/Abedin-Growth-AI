const fs = require('fs');
const file = 'server/agents/salesDecisionEngine.ts';
let code = fs.readFileSync(file, 'utf8');

const anchorStart = `  // Actually generate via Gemini for a more powerful and adaptive response, 
  // falling back to rule-based logic if not explicitly requested or if AI fails.
  if (process.env.USE_GENAI_FOR_REPLIES === 'true') {
     console.log("[SalesDecisionEngine] Invoking powerful Gemini generation...");
     // Real implementation would invoke geminiClient.generateContent(...)
     // For this environment, we will use the highly reliable deterministic composer below
     // but the architecture is now fully wired for it.
  }`;

const replacement = `  // F. FACT FRESHNESS & K. QUOTE SNAPSHOT
  let dynamicFacts = "";
  try {
     const quotes = await ledgerService.getQuotes ? await ledgerService.getQuotes(input.identity.email) : [];
     if (quotes && quotes.length > 0) dynamicFacts += "Active Quote: " + JSON.stringify(quotes) + "\\n";
  } catch(e){}

  const firstName = input.identity.name?.replace(/^Dr\\.\\s+/i, "").split(" ")[0] || "there";
  const companyName = input.identity.company || "your team";

  const replyPlan: ReplyPlan = {
    contact: {
      name: input.identity.name,
      company: input.identity.company,
      email: input.identity.email,
    },
    product: "Abedin Voice AI",
    primaryIntent: input.emailUnderstanding.primaryIntent,
    secondaryIntents: input.emailUnderstanding.secondaryIntents,
    buyingStage: input.buyingStage,
    purchaseReadiness: input.nextBestAction.pricingAllowed ? 70 : 40,
    meetingReadiness: input.nextBestAction.meetingLinkAllowed ? 80 : 35,
    questionsToAnswer: input.nextBestAction.questionsToAnswer,
    knownRelevantFacts: [
      \`Abedin Voice AI operates at sub-500ms latency for natural phone conversations\`,
      \`Syncs directly with Google Calendar and CRM systems\`,
    ],
    objections: input.emailUnderstanding.objections,
    missingInformation: input.nextBestAction.missingInformation,
    specialistsRequired: [
      input.nextBestAction.technicalAgentRequired ? "TECHNICAL" : null,
      input.nextBestAction.pricingAgentRequired ? "PRICING" : null,
      input.nextBestAction.objectionAgentRequired ? "OBJECTION" : null,
      input.nextBestAction.roiAgentRequired ? "ROI" : null,
    ].filter(Boolean) as ("TECHNICAL" | "PRICING" | "OBJECTION" | "ROI")[],
    nextBestAction: input.nextBestAction.action,
    sendBookingLink: input.nextBestAction.meetingLinkAllowed,
    sendOnboardingLink: input.nextBestAction.action === "START_ONBOARDING",
    reason: input.nextBestAction.reason,
  };

  if (process.env.USE_GENAI_FOR_REPLIES === 'true') {
     console.log("[SalesDecisionEngine] Invoking powerful Gemini generation...");
     const prompt = \`
You are an expert, professional founder doing B2B sales for Abedin Voice AI.
Write an email response to \${firstName} at \${companyName}.
Their email said: "\${input.rawInboundText}"
Our intent: \${input.nextBestAction.action}
Strategy: \${input.nextBestAction.reason}

Use these canonical facts if relevant:
\${JSON.stringify(CANONICAL_KNOWLEDGE)}
\${dynamicFacts}

Keep the tone concise, professional, warm, and highly relevant. Don't be overly salesy.
Return JSON ONLY:
{
  "subject": "Email subject",
  "body": "HTML formatted email body"
}
\`;
     const aiResult = await safeGenerateJSON<{subject: string, body: string}>({
       prompt,
       category: "SMART",
       fallbackData: { subject: "", body: "" }
     });
     
     if (aiResult && aiResult.body) {
        return {
           subject: aiResult.subject,
           body: aiResult.body,
           replyPlan
        };
     }
  }`;

// We need to replace the entire chunk until `switch (input.nextBestAction.action) {`
const endAnchor = `switch (input.nextBestAction.action) {`;

const blockStart = code.indexOf(`  // F. FACT FRESHNESS & K. QUOTE SNAPSHOT`);
const blockEnd = code.indexOf(endAnchor);

if (blockStart !== -1 && blockEnd !== -1) {
   const before = code.substring(0, blockStart);
   const after = code.substring(blockEnd);
   code = before + replacement + "\n\n  let body = \"\";\n  const subject = input.rawInboundText.toLowerCase().includes(\"re:\") ? \"Re: Abedin Voice AI\" : \"Re: 24/7 AI Voice Receptionist for \" + companyName;\n  " + after;
   fs.writeFileSync(file, code);
   console.log("Success");
} else {
   console.log("Failed to find anchors");
}
