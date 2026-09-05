const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// There's a duplicate section because of the multiple replacement issue, and also a bad </span></span>.
const badSection = `                <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Alert If &lt;</span></span>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    placeholder="--"
                    value={thresholds[camp.id] || ''}
                    onChange={(e) => handleThresholdChange(camp.id, e.target.value)}
                    className="w-8 text-xs font-bold text-slate-700 bg-transparent text-center focus:outline-none focus:ring-1 focus:ring-rose-400 rounded"
                  />
                  <span className="text-[10px] font-bold text-slate-400 uppercase">%</span>
                </div>
                <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Alert If &lt;</span></span>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    placeholder="--"
                    value={thresholds[camp.id] || ''}
                    onChange={(e) => handleThresholdChange(camp.id, e.target.value)}
                    className="w-8 text-xs font-bold text-slate-700 bg-transparent text-center focus:outline-none focus:ring-1 focus:ring-rose-400 rounded"
                  />
                  <span className="text-[10px] font-bold text-slate-400 uppercase">%</span>
                </div>`;

const goodSection = `                <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Alert If &lt;</span>
                  <input 
                    type="number"
                    min="0"
                    max="100"
                    placeholder="--"
                    value={thresholds[camp.id] || ''}
                    onChange={(e) => handleThresholdChange(camp.id, e.target.value)}
                    className="w-8 text-xs font-bold text-slate-700 bg-transparent text-center focus:outline-none focus:ring-1 focus:ring-rose-400 rounded"
                  />
                  <span className="text-[10px] font-bold text-slate-400 uppercase">%</span>
                </div>`;

code = code.replace(badSection, goodSection);
fs.writeFileSync('src/pages/CampaignsView.tsx', code);
