const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// 1. Add imports
code = code.replace(
  'import { Campaign } from "../types";',
  `import { Campaign } from "../types";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";`
);

// 2. Add mock data generator inside component or before it
const mockDataGen = `
const generateMockChartData = (enrolledCount: number, seed: string) => {
  const data = [];
  let baseEng = Math.max(5, Math.floor(enrolledCount * 0.1));
  let baseConv = Math.max(1, Math.floor(enrolledCount * 0.02));
  
  // Use a simple seed based on campaign id length or char codes
  const seedNum = seed.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    
    // Add realistic-looking sinusoidal noise
    const engVal = Math.max(0, Math.floor(baseEng + Math.sin(i + seedNum) * (baseEng * 0.3) + Math.random() * (baseEng * 0.2)));
    const convVal = Math.max(0, Math.floor(baseConv + Math.cos(i + seedNum) * (baseConv * 0.3) + Math.random() * (baseConv * 0.2)));
    
    // cumulative growth for conversion maybe, or just daily. Let's do daily active
    data.push({
      date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      engagement: engVal,
      conversion: convVal
    });
  }
  return data;
};
`;

code = code.replace(
  'interface CampaignsViewProps {',
  mockDataGen + '\ninterface CampaignsViewProps {'
);


// 3. Add the chart below AI Strategy Summary
const chartUI = `
            {/* 30-Day Trend Chart for Active Campaigns */}
            {camp.status === "ACTIVE" && (
              <div className="pt-2">
                <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                  30-Day Performance Trend
                </div>
                <div className="h-48 w-full bg-white border border-slate-100 rounded-xl p-3 shadow-xs">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={generateMockChartData(camp.enrolledCount, camp.id)}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis 
                        dataKey="date" 
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 10, fill: '#94a3b8' }}
                        dy={10}
                        minTickGap={20}
                      />
                      <YAxis 
                        axisLine={false}
                        tickLine={false}
                        tick={{ fontSize: 10, fill: '#94a3b8' }}
                        dx={-10}
                      />
                      <Tooltip 
                        contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)', fontSize: '12px' }}
                      />
                      <Line 
                        type="monotone" 
                        name="Engagement"
                        dataKey="engagement" 
                        stroke="#3b82f6" 
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                      <Line 
                        type="monotone" 
                        name="Conversion"
                        dataKey="conversion" 
                        stroke="#10b981" 
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
`;

code = code.replace(
  '            {/* Step Sequence Accordion Preview */}',
  chartUI + '\n            {/* Step Sequence Accordion Preview */}'
);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
