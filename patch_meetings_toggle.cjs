const fs = require('fs');
let code = fs.readFileSync('src/pages/MeetingsView.tsx', 'utf8');

const targetStr = `              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Automations:
                </span>
                <button`;

const newStr = `              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  Automations:
                </span>
                <label className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold rounded-lg bg-white border border-slate-200 text-slate-700 cursor-pointer hover:bg-slate-50 transition-colors">
                  <input type="checkbox" className="accent-blue-600 rounded-sm" defaultChecked={true} />
                  <span>Auto-Send Recap</span>
                </label>
                <button`;

code = code.replace(targetStr, newStr);

fs.writeFileSync('src/pages/MeetingsView.tsx', code);
