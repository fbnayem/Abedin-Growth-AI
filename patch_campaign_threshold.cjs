const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

// 1. Add AlertCircle to imports
code = code.replace(
  'BarChart2,\n} from "lucide-react";',
  'BarChart2,\n  AlertCircle,\n} from "lucide-react";'
);

// 2. Add Threshold State and handler
const stateStr = `  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompareModal, setShowCompareModal] = useState(false);`;

const stateWithThreshold = `  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [showCompareModal, setShowCompareModal] = useState(false);
  const [thresholds, setThresholds] = useState<Record<string, number>>({});

  const handleThresholdChange = (campId: string, value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num) && num >= 0 && num <= 100) {
      setThresholds(prev => ({ ...prev, [campId]: num }));
    } else if (value === '') {
      const newT = { ...thresholds };
      delete newT[campId];
      setThresholds(newT);
    }
  };`;

code = code.replace(stateStr, stateWithThreshold);

// 3. Update Header row to include the Threshold input
const headerStr = `                  <h3 className="text-base font-bold text-slate-900">{camp.name}</h3>`;
const headerWithAlert = `                  <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                    {camp.name}
                    {thresholds[camp.id] !== undefined && 
                     (camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100 : 0) < thresholds[camp.id] && (
                      <div className="relative group flex items-center">
                        <AlertCircle className="w-4 h-4 text-rose-500 animate-pulse" />
                        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 hidden group-hover:block w-max bg-slate-900 text-white text-[10px] py-1 px-2 rounded font-medium shadow-xl">
                          Conversion Rate ({(camp.enrolledCount > 0 ? (camp.convertedCount / camp.enrolledCount) * 100).toFixed(1)}%) is below threshold ({thresholds[camp.id]}%)
                        </div>
                      </div>
                    )}
                  </h3>`;

code = code.replace(/<h3 className="text-base font-bold text-slate-900">\{camp.name\}<\/h3>/g, headerWithAlert);

// 4. Update the actions section to add a threshold input
const actionsStr = `              {/* Status Toggle & Metrics */}
              <div className="flex items-center gap-2">`;
              
const actionsWithThreshold = `              {/* Status Toggle & Metrics */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded-lg">
                  <span className="text-[10px] font-bold text-slate-400 uppercase">Alert If <</span>
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

code = code.replace(actionsStr, actionsWithThreshold);
// Global replace just in case
code = code.split(actionsStr).join(actionsWithThreshold);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
