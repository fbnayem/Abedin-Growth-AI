const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// 1. Update imports
code = code.replace(
  'Filter,\n  ArrowDownUp,\n} from "lucide-react";',
  'Filter,\n  ArrowDownUp,\n  BarChart2,\n} from "lucide-react";\nimport { CampaignCompareModal } from "./CampaignCompareModal";'
);

// 2. Export generateMockChartData
code = code.replace(
  'const generateMockChartData = (enrolledCount: number, seed: string) => {',
  'export const generateMockChartData = (enrolledCount: number, seed: string) => {'
);

// 3. Add States
const componentStart = `export const CampaignsView: React.FC<CampaignsViewProps> = ({
  campaigns,
  onOpenNewCampaign,
  onToggleCampaignStatus,
}) => {`;

const statesToAdd = `
  const [isCompareMode, setIsCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompareModal, setShowCompareModal] = useState(false);

  const handleCardClick = (id: string) => {
    if (!isCompareMode) return;
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(p => p !== id);
      if (prev.length < 2) return [...prev, id];
      return prev;
    });
  };
`;

code = code.replace(componentStart, componentStart + statesToAdd);

// 4. Add Compare Button to Filters
const filtersUI = `      {/* Filters & Sorting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 bg-white rounded-xl border border-slate-200 shadow-xs">`;

const filtersWithCompare = `      {/* Filters & Sorting */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-3 bg-white rounded-xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          <button
            onClick={() => {
              setIsCompareMode(!isCompareMode);
              setCompareIds([]);
            }}
            className={\`px-3 py-1.5 rounded-lg text-[11px] font-bold whitespace-nowrap transition-colors uppercase flex items-center gap-1.5 mr-2 \${
              isCompareMode
                ? "bg-purple-100 text-purple-700 border border-purple-200"
                : "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
            }\`}
          >
            <BarChart2 className="w-3.5 h-3.5" />
            {isCompareMode ? "Cancel Compare" : "Compare"}
          </button>
          <div className="w-px h-5 bg-slate-200 mx-1"></div>
          <Filter className="w-4 h-4 text-slate-400 mr-1" />`;

code = code.replace(
  /\{\/\* Filters & Sorting \*\/\}[\s\S]*?<Filter className="w-4 h-4 text-slate-400 mr-1" \/>/,
  filtersWithCompare
);

// 5. Update Card to Handle Clicks and Borders
const oldCardWrapper = `<div
            key={camp.id}
            className="flex flex-col p-5 rounded-xl bg-white border border-slate-200 shadow-2xs hover:shadow-sm transition-all space-y-4"
          >`;

const newCardWrapper = `<div
            key={camp.id}
            onClick={() => handleCardClick(camp.id)}
            className={\`flex flex-col p-5 rounded-xl bg-white border shadow-2xs transition-all space-y-4 \${
              isCompareMode ? "cursor-pointer hover:border-purple-300" : "hover:shadow-sm border-slate-200"
            } \${compareIds.includes(camp.id) ? "ring-2 ring-purple-500 border-purple-500 bg-purple-50/10" : ""}\`}
          >`;

code = code.replace(oldCardWrapper, newCardWrapper);

// We need a global replace just in case there are multiple matches, or we just do string replacement
// Let's use global replace just in case. Wait, it's safer to just replace all instances.
code = code.split(oldCardWrapper).join(newCardWrapper);


// 6. Add sticky banner and modal at the end of the component
const endOfComponent = `    </div>
  );
};`;

const modalsAndBanners = `
      {/* Sticky Banner for Compare Mode */}
      {isCompareMode && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-4 z-40 animate-in slide-in-from-bottom-5">
          <span className="text-sm font-medium">
            {compareIds.length === 0 && "Select 2 campaigns to compare"}
            {compareIds.length === 1 && "Select 1 more campaign"}
            {compareIds.length === 2 && "Ready to compare"}
          </span>
          {compareIds.length === 2 && (
            <button
              onClick={() => setShowCompareModal(true)}
              className="px-4 py-1.5 bg-purple-500 hover:bg-purple-600 rounded-full text-xs font-bold transition-colors"
            >
              View Comparison
            </button>
          )}
        </div>
      )}

      {/* Compare Modal */}
      <CampaignCompareModal
        isOpen={showCompareModal}
        onClose={() => setShowCompareModal(false)}
        campaign1={campaigns.find(c => c.id === compareIds[0]) || null}
        campaign2={campaigns.find(c => c.id === compareIds[1]) || null}
      />
    </div>
  );
};`;

code = code.replace(endOfComponent, modalsAndBanners);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
