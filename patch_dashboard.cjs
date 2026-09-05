const fs = require('fs');
let code = fs.readFileSync('src/pages/DashboardView.tsx', 'utf8');

// 1. Update interface
code = code.replace(
  '    investorConversations: number;\n    partnerConversations: number;',
  '    investorConversations: number;\n    partnerConversations: number;\n    projectedMonthlyRevenue?: number;'
);

// 2. Update default props
code = code.replace(
  '    investorConversations: 0,\n    partnerConversations: 0,\n  },',
  '    investorConversations: 0,\n    partnerConversations: 0,\n    projectedMonthlyRevenue: 0,\n  },'
);

// 3. Update safeKpis
code = code.replace(
  '    investorConversations: kpis?.investorConversations || 0,\n    partnerConversations: kpis?.partnerConversations || 0,\n  };',
  '    investorConversations: kpis?.investorConversations || 0,\n    partnerConversations: kpis?.partnerConversations || 0,\n    projectedMonthlyRevenue: kpis?.projectedMonthlyRevenue || 0,\n  };'
);

// 4. Update the Grid
code = code.replace(
  'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  'grid-cols-2 sm:grid-cols-3 lg:grid-cols-7'
);

// 5. Add the new card next to "Pipeline Value"
const pipelineCard = `        {/* Pipeline Value */}
        <div
          onClick={() => onNavigateTab("pipeline")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-emerald-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Pipeline Value</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            £{Math.round(safeKpis.pipelineValue / 1000)}k
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">Annual Contract Value</div>
        </div>`;

const newCard = `        {/* Pipeline Value */}
        <div
          onClick={() => onNavigateTab("pipeline")}
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-emerald-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Pipeline Value</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            £{Math.round(safeKpis.pipelineValue / 1000)}k
          </div>
          <div className="text-[10px] text-slate-500 font-medium mt-0.5">Annual Contract Value</div>
        </div>
        {/* Projected Monthly Revenue */}
        <div
          className="p-4 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-xs transition-all group"
        >
          <div className="flex items-center justify-between text-slate-400 group-hover:text-blue-600">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Proj. MRR</span>
            <Flame className="w-4 h-4 text-blue-500" />
          </div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            £{Math.round(safeKpis.projectedMonthlyRevenue! / 1000)}k
          </div>
          <div className="text-[10px] text-blue-600 font-medium mt-0.5">+12% vs Last Month</div>
        </div>`;

code = code.replace(pipelineCard, newCard);

fs.writeFileSync('src/pages/DashboardView.tsx', code);
