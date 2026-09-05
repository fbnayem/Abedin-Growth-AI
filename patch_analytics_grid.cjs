const fs = require('fs');
let code = fs.readFileSync('src/pages/AnalyticsView.tsx', 'utf8');

const target1 = `{/* Conversion Funnel Bar */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">`;
const replace1 = `{/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Conversion Funnel Bar */}
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">`;

code = code.replace(target1, replace1);

const target2 = `        </div>
      </div>
      
      {/* Lead Distribution Donut Chart */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">`;

const replace2 = `        </div>
      </div>
      
      {/* Lead Distribution Donut Chart */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4 h-full flex flex-col">`;

code = code.replace(target2, replace2);


const target3 = `        </div>
      </div>
    </div>
  );
};`;

const replace3 = `        </div>
      </div>
      </div>
    </div>
  );
};`;
code = code.replace(target3, replace3);

fs.writeFileSync('src/pages/AnalyticsView.tsx', code);
