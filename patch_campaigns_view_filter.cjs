const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// 1. Update imports
code = code.replace(
  'import React from "react";',
  'import React, { useState } from "react";'
);
code = code.replace(
  'TrendingUp,\n} from "lucide-react";',
  'TrendingUp,\n  Filter,\n  ArrowDownUp,\n} from "lucide-react";'
);

// 2. Add state and logic inside component
const componentStart = `
export const CampaignsView: React.FC<CampaignsViewProps> = ({
  campaigns,
  onOpenNewCampaign,
  onToggleCampaignStatus,
}) => {
`;

const stateAndLogic = `
  const [filterStatus, setFilterStatus] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<string>("date_desc");

  const processedCampaigns = [...campaigns]
    .filter((c) => filterStatus === "ALL" || c.status === filterStatus)
    .sort((a, b) => {
      if (sortBy === "date_desc") return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      if (sortBy === "date_asc") return new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime();
      if (sortBy === "conversion_desc") {
        const aConv = a.enrolledCount > 0 ? a.convertedCount / a.enrolledCount : 0;
        const bConv = b.enrolledCount > 0 ? b.convertedCount / b.enrolledCount : 0;
        return bConv - aConv;
      }
      if (sortBy === "engagement_desc") {
        const aEng = a.sentCount > 0 ? a.openedCount / a.sentCount : 0;
        const bEng = b.sentCount > 0 ? b.openedCount / b.sentCount : 0;
        return bEng - aEng;
      }
      return 0;
    });
`;

code = code.replace(componentStart, componentStart + stateAndLogic);

// 3. Inject Filter UI
const filterUI = `
      {/* Filters & Sorting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 bg-white rounded-xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          <Filter className="w-4 h-4 text-slate-400 mr-1" />
          {["ALL", "ACTIVE", "PAUSED", "COMPLETED", "DRAFT"].map((status) => (
            <button
              key={status}
              onClick={() => setFilterStatus(status)}
              className={\`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors uppercase \${
                filterStatus === status
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }\`}
            >
              {status === "ALL" ? "All" : status}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <ArrowDownUp className="w-4 h-4 text-slate-400" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="pl-3 pr-8 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 cursor-pointer appearance-none"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3csvg xmlns=\\'http://www.w3.org/2000/svg\\' fill=\\'none\\' viewBox=\\'0 0 20 20\\'%3e%3cpath stroke=\\'%236b7280\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\' stroke-width=\\'1.5\\' d=\\'M6 8l4 4 4-4\\'/%3e%3c/svg%3e")', backgroundPosition: 'right 0.5rem center', backgroundRepeat: 'no-repeat', backgroundSize: '1.5em 1.5em' }}
          >
            <option value="date_desc">Newest First</option>
            <option value="date_asc">Oldest First</option>
            <option value="conversion_desc">Highest Conversion</option>
            <option value="engagement_desc">Highest Engagement</option>
          </select>
        </div>
      </div>
`;

code = code.replace(
  '      {/* Campaigns Grid / List */}\n      <div className="space-y-4">\n        {campaigns.map((camp) => (',
  filterUI + '\n      {/* Campaigns Grid / List */}\n      <div className="space-y-4">\n        {processedCampaigns.map((camp) => ('
);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
