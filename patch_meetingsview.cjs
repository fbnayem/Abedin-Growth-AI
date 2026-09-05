const fs = require('fs');
let code = fs.readFileSync('src/pages/MeetingsView.tsx', 'utf8');

// 1. Imports
code = code.replace(
  'import { Meeting } from "../types";',
  'import { Meeting, CompanyBrain } from "../types";'
);

code = code.replace(
  '  Send,\n} from "lucide-react";',
  '  Send,\n  UploadCloud,\n  X,\n  FileText,\n  Bot,\n} from "lucide-react";'
);

// 2. Props
code = code.replace(
  'interface MeetingsViewProps {\n  meetings: Meeting[];',
  'interface MeetingsViewProps {\n  meetings: Meeting[];\n  companyBrain?: CompanyBrain | null;'
);

code = code.replace(
  '  onRefreshMeetings,\n}) => {',
  '  onRefreshMeetings,\n  companyBrain,\n}) => {'
);

// 3. State
const newStates = `  const [showTranscriptModal, setShowTranscriptModal] = useState(false);
  const [transcriptText, setTranscriptText] = useState("");
  const [isProcessingTranscript, setIsProcessingTranscript] = useState(false);
  const [generatedActionItems, setGeneratedActionItems] = useState<{ [meetingId: string]: string[] }>({});

  const handleProcessTranscript = () => {
    if (!activeMeeting || !transcriptText.trim()) return;
    setIsProcessingTranscript(true);
    
    // Simulate AI processing using companyBrain
    setTimeout(() => {
      const companyInfo = companyBrain ? \` leveraging \${companyBrain.companyName}'s \${companyBrain.valueProposition?.toLowerCase().substring(0, 30)}...\` : "";
      
      const newItems = [
        \`Follow up with \${activeMeeting.prospectName} regarding specific operational pain points mentioned.\`,
        \`Send proposal\${companyInfo} as discussed.\`,
        "Schedule onboarding sync for next Tuesday."
      ];
      
      setGeneratedActionItems(prev => ({
        ...prev,
        [activeMeeting.id]: newItems
      }));
      
      setIsProcessingTranscript(false);
      setShowTranscriptModal(false);
      setTranscriptText("");
    }, 1500);
  };
`;

code = code.replace(
  '  const [sendingReminder, setSendingReminder] = useState<string | null>(null);',
  '  const [sendingReminder, setSendingReminder] = useState<string | null>(null);\n' + newStates
);

// 4. Upload Transcript Button in Header
const btnHtml = `                <button
                  onClick={() => setShowLiveRoom(true)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1.5"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  <span>Launch Live Closing Room</span>
                </button>`;

const newBtnHtml = `                <button
                  onClick={() => setShowTranscriptModal(true)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 border border-purple-200 transition-colors flex items-center gap-1.5"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>Upload Transcript</span>
                </button>
                <button
                  onClick={() => setShowLiveRoom(true)}
                  className="px-3.5 py-1.5 rounded-xl text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors flex items-center gap-1.5"
                >
                  <PhoneCall className="w-3.5 h-3.5" />
                  <span>Launch Live Closing Room</span>
                </button>`;
code = code.replace(btnHtml, newBtnHtml);

// 5. Display Action Items in Brief Section
const actionItemsDisplayHtml = `            {/* Brief Sections */}
            {activeMeeting.aiBrief ? (
              <div className="space-y-5">
                {/* AI Action Items from Transcript */}
                {generatedActionItems[activeMeeting.id] && (
                  <div className="p-4 bg-purple-50/70 rounded-xl border border-purple-100 space-y-2 animate-in fade-in slide-in-from-top-2">
                    <div className="text-xs font-bold uppercase tracking-wider text-purple-900 flex items-center gap-1.5">
                      <Bot className="w-3.5 h-3.5 text-purple-600" />
                      <span>Extracted Action Items (AI)</span>
                    </div>
                    <ul className="space-y-1.5">
                      {generatedActionItems[activeMeeting.id].map((item, i) => (
                        <li key={i} className="text-xs text-purple-800 flex items-start gap-2 bg-white/60 p-2.5 rounded-lg border border-purple-200/60">
                          <CheckCircle2 className="w-4 h-4 text-purple-500 shrink-0 mt-0.5" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}`;
code = code.replace('{/* Brief Sections */}\n            {activeMeeting.aiBrief ? (\n              <div className="space-y-5">', actionItemsDisplayHtml);

// 6. Modal Component at end
const modalHtml = `      {showTranscriptModal && activeMeeting && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center border border-purple-200">
                  <FileText className="w-4 h-4 text-purple-600" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-900">Upload Transcript</h3>
                  <p className="text-[11px] text-slate-500 font-medium mt-0.5">Generate action items using {companyBrain?.companyName || "AI"} Context</p>
                </div>
              </div>
              <button onClick={() => setShowTranscriptModal(false)} className="p-1 rounded-lg hover:bg-slate-200 text-slate-400 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            
            <div className="p-5 flex-1 overflow-y-auto">
              <label className="block text-xs font-semibold text-slate-700 mb-2">
                Paste Meeting Transcript
              </label>
              <textarea
                value={transcriptText}
                onChange={(e) => setTranscriptText(e.target.value)}
                placeholder="[00:00] Prospect: We're having issues scaling..."
                className="w-full h-48 p-3 text-xs font-mono text-slate-700 border border-slate-300 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none resize-none bg-slate-50"
              />
            </div>
            
            <div className="px-5 py-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
              <button 
                onClick={() => setShowTranscriptModal(false)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleProcessTranscript}
                disabled={isProcessingTranscript || !transcriptText.trim()}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50 transition-colors flex items-center gap-2 shadow-sm"
              >
                {isProcessingTranscript ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : (
                  <>
                    <Bot className="w-4 h-4" />
                    <span>Generate Action Items</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};`;

code = code.replace(/    <\/div>\n  \);\n};\s*$/, modalHtml);

fs.writeFileSync('src/pages/MeetingsView.tsx', code);
