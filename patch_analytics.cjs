const fs = require('fs');
let code = fs.readFileSync('src/pages/AnalyticsView.tsx', 'utf8');

// 1. Add imports
code = code.replace(
  'import { apiFetch } from \'../lib/apiFetch\';',
  'import { apiFetch } from \'../lib/apiFetch\';\nimport { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";'
);

// 2. Add sample donut data to component state
const donutStateStr = `  const [funnelSteps, setFunnelSteps] = React.useState<any[]>([`;
const donutDataStr = `
  const donutData = [
    { name: 'New (Discovered)', value: 120, color: '#334155' },
    { name: 'Qualified', value: 80, color: '#2563eb' },
    { name: 'Contacted', value: 45, color: '#4f46e5' },
    { name: 'Meeting Booked', value: 15, color: '#10b981' },
    { name: 'Closed Won', value: 5, color: '#059669' },
  ];
  const [funnelSteps, setFunnelSteps] = React.useState<any[]>([`;
code = code.replace(donutStateStr, donutDataStr);

// 3. Add Donut Chart UI next to Conversion Funnel
const funnelEndStr = `        </div>
      </div>
    </div>
  );
};`;

const doubleGridStr = `        </div>
      </div>
      
      {/* Lead Distribution Donut Chart */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-emerald-600" />
            <h3 className="text-sm font-bold text-slate-900">Lead Status Distribution</h3>
          </div>
          <span className="text-xs text-slate-400 font-medium">Pipeline Snapshot</span>
        </div>
        
        <div className="h-64 w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={donutData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={80}
                paddingAngle={5}
                dataKey="value"
              >
                {donutData.map((entry, index) => (
                  <Cell key={\`cell-\${index}\`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip 
                contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px' }}
                itemStyle={{ fontWeight: 'bold' }}
              />
              <Legend 
                verticalAlign="bottom" 
                height={36}
                iconType="circle"
                wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};`;

code = code.replace(funnelEndStr, doubleGridStr);

fs.writeFileSync('src/pages/AnalyticsView.tsx', code);
