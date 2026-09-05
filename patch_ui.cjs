const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

const targetStr = `                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  value={enrolledCount}
                  onChange={(e) => setEnrolledCount(Number(e.target.value))}
                  className="w-full"
                />
              </div>`;

const abTestingUI = `                <input
                  type="range"
                  min="5"
                  max="100"
                  step="5"
                  value={enrolledCount}
                  onChange={(e) => setEnrolledCount(Number(e.target.value))}
                  className="w-full"
                />
              </div>
              
              {/* A/B Testing Toggle */}
              <div 
                className={\`p-4 rounded-xl border flex items-center justify-between cursor-pointer transition-colors \${isABTestingEnabled ? 'bg-purple-50 border-purple-200' : 'bg-slate-50 border-slate-200 hover:bg-slate-100'}\`}
                onClick={() => setIsABTestingEnabled(!isABTestingEnabled)}
              >
                <div className="flex items-center gap-3">
                  <div className={\`w-8 h-8 rounded-lg flex items-center justify-center \${isABTestingEnabled ? 'bg-purple-200 text-purple-700' : 'bg-slate-200 text-slate-500'}\`}>
                    <Split className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className={\`text-xs font-bold \${isABTestingEnabled ? 'text-purple-900' : 'text-slate-700'}\`}>Enable A/B Testing Mode</h4>
                    <p className={\`text-[11px] mt-0.5 \${isABTestingEnabled ? 'text-purple-700' : 'text-slate-500'}\`}>
                      Automatically splits outreach into two variations for statistical comparison
                    </p>
                  </div>
                </div>
                <div className={\`w-10 h-5 rounded-full flex items-center px-1 transition-colors \${isABTestingEnabled ? 'bg-purple-600' : 'bg-slate-300'}\`}>
                  <div className={\`w-3.5 h-3.5 rounded-full bg-white transition-transform \${isABTestingEnabled ? 'translate-x-4.5' : 'translate-x-0'}\`} />
                </div>
              </div>`;

code = code.replace(targetStr, abTestingUI);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
