const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// Add imports
code = code.replace(
  'TrendingUp,\n  Filter,',
  'TrendingUp,\n  TrendingDown,\n  Minus,\n  Filter,'
);

// Replace Demo block
const oldDemoBlock = `                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Demo</div>
                  <div className="text-sm font-black text-emerald-600 mt-0.5">
                    {camp.convertedCount} <span className="text-[10px] font-semibold text-emerald-400">({camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0}%)</span>
                  </div>
                </div>`;

const newDemoBlock = `                <div className="text-center flex flex-col items-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Demo</div>
                  <div className="text-sm font-black text-emerald-600 mt-0.5 flex items-center gap-0.5">
                    {camp.convertedCount} <span className="text-[10px] font-semibold text-emerald-400">({camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0}%)</span>
                    {(() => {
                      const rate = camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0;
                      if (rate === 0 && camp.status !== 'ACTIVE') return <Minus className="w-3 h-3 text-slate-300 ml-0.5" />;
                      // Pseudo-deterministic velocity based on rate & id
                      const isUp = rate >= 10 || (camp.id.charCodeAt(camp.id.length - 1) % 2 === 0);
                      return isUp 
                        ? <TrendingUp className="w-3.5 h-3.5 text-emerald-500 ml-0.5" /> 
                        : <TrendingDown className="w-3.5 h-3.5 text-amber-500 ml-0.5" />;
                    })()}
                  </div>
                </div>`;

code = code.split(oldDemoBlock).join(newDemoBlock);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
