const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignWizardModal.tsx', 'utf8');

code = code.replace(
  'const [strategySummary, setStrategySummary] = useState<string>("");',
  'const [strategySummary, setStrategySummary] = useState<string>("");\n  const [projectedMetrics, setProjectedMetrics] = useState<{ reach: number; engagement: number; conversion: number; } | null>(null);'
);

code = code.replace(
  'setStrategySummary("");',
  'setStrategySummary("");\n      setProjectedMetrics(null);'
);

code = code.replace(
  'setStrategySummary(createdCampaign.aiStrategySummary || "");',
  'setStrategySummary(createdCampaign.aiStrategySummary || "");\n      setProjectedMetrics(createdCampaign.projectedMetrics || null);'
);

const metricsUI = `
              {projectedMetrics && (
                <div className="grid grid-cols-3 gap-2">
                  <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100 text-center">
                    <div className="text-[10px] font-bold text-blue-400 uppercase tracking-wider">Proj. Reach</div>
                    <div className="text-sm font-black text-blue-900 mt-0.5">{projectedMetrics.reach} Leads</div>
                  </div>
                  <div className="p-3 bg-amber-50/50 rounded-lg border border-amber-100 text-center">
                    <div className="text-[10px] font-bold text-amber-400 uppercase tracking-wider">Est. Engagement</div>
                    <div className="text-sm font-black text-amber-900 mt-0.5">{projectedMetrics.engagement} Opens</div>
                  </div>
                  <div className="p-3 bg-emerald-50/50 rounded-lg border border-emerald-100 text-center">
                    <div className="text-[10px] font-bold text-emerald-500 uppercase tracking-wider">Est. Conversion</div>
                    <div className="text-sm font-black text-emerald-900 mt-0.5">{projectedMetrics.conversion} Demos</div>
                  </div>
                </div>
              )}
`;

code = code.replace(
  '<p className="text-slate-700">{strategySummary}</p>\n              </div>\n              <div className="space-y-2.5">',
  '<p className="text-slate-700">{strategySummary}</p>\n              </div>\n' + metricsUI + '\n              <div className="space-y-2.5">'
);

fs.writeFileSync('src/pages/CampaignWizardModal.tsx', code);
