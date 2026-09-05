const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

const mapStart = `      {/* Campaigns Grid / List */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {processedCampaigns.map((camp) => (
          <div
            key={camp.id}
            className="flex flex-col p-5 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-sm transition-all space-y-4"
          >
            {/* Header row */}`;

code = code.replace(
  /\{\/\* Campaigns Grid \/ List \*\/\}[\s\S]*?\{\/\* Header row \*\/\}/m,
  mapStart
);

const statsStrip = `
            {/* Grouped Performance & Chart (Only if ACTIVE, otherwise just stats) */}
            <div className="flex-1 flex flex-col space-y-4">
              {/* Performance Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-100 text-xs">
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Reach</div>
                  <div className="text-sm font-black text-slate-800 mt-0.5">{camp.enrolledCount}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Sent</div>
                  <div className="text-sm font-black text-slate-800 mt-0.5">{camp.sentCount}</div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Open</div>
                  <div className="text-sm font-black text-blue-600 mt-0.5">
                    {camp.openedCount} <span className="text-[10px] font-semibold text-blue-400">({camp.sentCount > 0 ? Math.round((camp.openedCount / camp.sentCount) * 100) : 0}%)</span>
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Reply</div>
                  <div className="text-sm font-black text-indigo-600 mt-0.5">
                    {camp.repliedCount} <span className="text-[10px] font-semibold text-indigo-400">({camp.sentCount > 0 ? Math.round((camp.repliedCount / camp.sentCount) * 100) : 0}%)</span>
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-slate-400 font-bold uppercase">Demo</div>
                  <div className="text-sm font-black text-emerald-600 mt-0.5">
                    {camp.convertedCount} <span className="text-[10px] font-semibold text-emerald-400">({camp.enrolledCount > 0 ? Math.round((camp.convertedCount / camp.enrolledCount) * 100) : 0}%)</span>
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-[10px] text-purple-400 font-bold uppercase">Proj.</div>
                  <div className="text-sm font-black text-purple-600 mt-0.5">
                    {Math.floor(camp.enrolledCount * 0.12)}
                  </div>
                </div>
              </div>

              {/* 30-Day Trend Chart for Active Campaigns */}
              {camp.status === "ACTIVE" && (
                <div className="flex-1 flex flex-col pt-1">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
                    30-Day Performance Trend
                  </div>
                  <div className="flex-1 min-h-[160px] w-full bg-white border border-slate-100 rounded-xl p-3 shadow-xs">
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
            </div>
`;

code = code.replace(
  /\{\/\* Performance Stats Strip \*\/\}[\s\S]*?\{\/\* AI Strategy Summary \*\/\}/m,
  statsStrip + '\n            {/* AI Strategy Summary */}'
);

const stepsGrid = `              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">`;
code = code.replace(
  /<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">/g,
  stepsGrid
);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
