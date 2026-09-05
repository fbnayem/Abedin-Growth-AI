const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

const targetStr = `                <button
                  onClick={() => onToggleCampaignStatus(camp.id)}
                  className={\`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors \${
                    camp.status === "ACTIVE"
                      ? "bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                  }\`}
                >
                  {camp.status === "ACTIVE" ? (
                    <>
                      <Pause className="w-3.5 h-3.5" />
                      <span>Pause</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5" />
                      <span>Resume</span>
                    </>
                  )}
                </button>`;

const newToggle = `                <button
                  onClick={() => onToggleCampaignStatus(camp.id)}
                  className="flex items-center gap-2 group focus:outline-none"
                  title={camp.status === "ACTIVE" ? "Pause Campaign" : "Activate Campaign"}
                >
                  <span className={\`text-[10px] font-bold uppercase transition-colors \${camp.status === "ACTIVE" ? "text-emerald-600" : "text-slate-400"}\`}>
                    {camp.status === "ACTIVE" ? "Active" : "Paused"}
                  </span>
                  <div className={\`w-9 h-5 rounded-full p-0.5 transition-colors relative \${
                    camp.status === "ACTIVE" ? "bg-emerald-500" : "bg-slate-300 group-hover:bg-slate-400"
                  }\`}>
                    <div className={\`w-4 h-4 rounded-full bg-white shadow-sm transition-transform \${
                      camp.status === "ACTIVE" ? "translate-x-4" : "translate-x-0"
                    }\`} />
                  </div>
                </button>`;

if(code.includes(targetStr)) {
  code = code.replace(targetStr, newToggle);
  fs.writeFileSync('src/pages/CampaignsView.tsx', code);
  console.log("Success");
} else {
  console.log("String not found");
}
