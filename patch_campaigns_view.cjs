const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

const newStats = `
            {/* Performance Stats Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Reach (Enrolled)</div>
                <div className="text-sm font-black text-slate-800 mt-0.5">{camp.enrolledCount}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Sent</div>
                <div className="text-sm font-black text-slate-800 mt-0.5">{camp.sentCount}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Engagement (Open)</div>
                <div className="text-sm font-black text-blue-600 mt-0.5">
                  {camp.openedCount} <span className="text-[10px] font-semibold text-blue-400">({camp.sentCount > 0 ? Math.round((camp.openedCount / camp.sentCount) * 100) : 0}%)</span>
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Engagement (Reply)</div>
                <div className="text-sm font-black text-indigo-600 mt-0.5">
                  {camp.repliedCount} <span className="text-[10px] font-semibold text-indigo-400">({camp.sentCount > 0 ? Math.round((camp.repliedCount / camp.sentCount) * 100) : 0}%)</span>
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-slate-400 font-bold uppercase">Conversion (Demo)</div>
                <div className="text-sm font-black text-emerald-600 mt-0.5">
                  {camp.convertedCount} <span className="text-[10px] font-semibold text-emerald-400">({camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0}%)</span>
                </div>
              </div>
            </div>
`;

code = code.replace(
  /\{\/\* Performance Stats Strip \*\/\}[\s\S]*?\{\/\* AI Strategy Summary \*\/\}/m,
  newStats + '            {/* AI Strategy Summary */}'
);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
