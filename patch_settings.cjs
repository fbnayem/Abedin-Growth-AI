const fs = require('fs');
let code = fs.readFileSync('src/pages/SettingsView.tsx', 'utf8');

const targetStr = `          <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={localSettings.autoCheckQualityControl}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  autoCheckQualityControl: e.target.checked,
                })
              }
              className="mt-0.5"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900">Automated Quality Control & Spam Inspection</span>
              <p className="text-slate-500">
                Every generated draft is inspected for spam trigger words, unrendered template tags, and hallucinated claims.
              </p>
            </div>
          </label>`;

const newStr = targetStr + `\n
          <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={localSettings.autoReengageStaleLeads}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  autoReengageStaleLeads: e.target.checked,
                })
              }
              className="mt-0.5"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900">Automated Stale Lead Re-engagement</span>
              <p className="text-slate-500">
                Periodically check pipeline for leads not contacted in &gt;30 days and automatically draft a "touch base" sequence.
              </p>
            </div>
          </label>`;

code = code.replace(targetStr, newStr);

fs.writeFileSync('src/pages/SettingsView.tsx', code);
