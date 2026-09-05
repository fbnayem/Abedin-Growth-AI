const fs = require('fs');
let code = fs.readFileSync('src/pages/LeadDetailModal.tsx', 'utf8');

// 1. Import CompanyBrain
code = code.replace(
  'import { Lead, Conversation, EmailMessage } from "../types";',
  'import { Lead, Conversation, EmailMessage, CompanyBrain } from "../types";'
);

// 2. Add companyBrain to Props
code = code.replace(
  'interface LeadDetailModalProps {\n  lead: Lead | null;',
  'interface LeadDetailModalProps {\n  lead: Lead | null;\n  companyBrain?: CompanyBrain | null;'
);

// 3. Add companyBrain to component destructuring
code = code.replace(
  'export const LeadDetailModal: React.FC<LeadDetailModalProps> = ({',
  'export const LeadDetailModal: React.FC<LeadDetailModalProps> = ({\n  companyBrain,'
);

// 4. Add state for AI generation
const statesToInject = `  const [isGeneratingAILine, setIsGeneratingAILine] = useState(false);

  const handleAISuggest = async () => {
    if (!lead || !companyBrain) return;
    setIsGeneratingAILine(true);
    
    // In a real app we'd call an API. Here we simulate a high-quality personalized open.
    setTimeout(() => {
      const snippets = lead.personalizationSnippets || [];
      const bestSnippet = snippets.length > 0 ? snippets[0].text : \`I saw your recent work at \${lead.companyName}\`;
      const valProp = companyBrain.valueProposition || "We help scale operations efficiently.";
      
      const suggestedDraft = \`Hi \${lead.name.split(" ")[0]},\n\n\${bestSnippet}. Given \${companyBrain.companyName}'s focus on \${valProp.toLowerCase().substring(0, 50)}..., I thought it would make sense to connect.\n\nWe built a solution specifically for teams like yours at \${lead.companyName}. Would you be open to a 2-minute test call this week?\n\nBest,\n\${companyBrain.founderName || "Founder"}\n\${companyBrain.companyName}\`;
      
      setEmailBody(suggestedDraft);
      setIsGeneratingAILine(false);
    }, 1200);
  };
`;

code = code.replace(
  '  const [replySubject, setReplySubject] = useState("");',
  statesToInject + '\n  const [replySubject, setReplySubject] = useState("");'
);

// 5. Add the AI Suggest button next to "Reset to Default Template"
const resetBtn = `                  <button
                    onClick={() => {
                      setEmailBody(
                        \`Hi \${lead.name.split(" ")[0]},\n\n\${lead.personalizationSnippets?.[0]?.text || "I noticed your team handles high appointment volume."}\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. It operates with sub-500ms voice speed and books directly into your calendar.\n\nWould you be open to a 2-minute test call on your mobile this week?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech\`
                      );
                    }}
                    className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold"
                  >
                    Reset to Default Template
                  </button>`;

const enhancedButtons = `                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleAISuggest}
                      disabled={isGeneratingAILine}
                      className="text-[11px] text-purple-600 hover:text-purple-700 font-bold flex items-center gap-1 disabled:opacity-50 transition-colors bg-purple-50 px-2 py-1 rounded-md border border-purple-100"
                    >
                      {isGeneratingAILine ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                      AI Suggest
                    </button>
                    <button
                      onClick={() => {
                        setEmailBody(
                          \`Hi \${lead.name.split(" ")[0]},\n\n\${lead.personalizationSnippets?.[0]?.text || "I noticed your team handles high appointment volume."}\n\nWe built Abedin Voice AI so clinics never miss high-value consultation calls after hours. It operates with sub-500ms voice speed and books directly into your calendar.\n\nWould you be open to a 2-minute test call on your mobile this week?\n\nBest regards,\nNayem Abedin\nFounder & CEO | Abedin Tech\`
                        );
                      }}
                      className="text-[11px] text-slate-500 hover:text-slate-700 font-semibold transition-colors"
                    >
                      Reset Template
                    </button>
                  </div>`;

code = code.replace(resetBtn, enhancedButtons);

fs.writeFileSync('src/pages/LeadDetailModal.tsx', code);
