const fs = require('fs');
let file = fs.readFileSync('src/pages/IntegrationsView.tsx', 'utf8');

// 1. Add Gmail OAuth fields
const emailSectionRegex = /(<ShieldCheck className="w-4 h-4 text-emerald-600" \/>\s*<span>SPF, DKIM, DMARC 100% compliant on abedintech.com<\/span>\s*<\/div>)/;

const gmailFields = `
            {/* GMAIL OAUTH FIELDS ADDED */}
            <div className="pt-4 border-t border-slate-100 mt-6">
              <h3 className="text-sm font-bold text-slate-800 mb-4">Google Cloud OAuth Credentials</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Gmail Client ID (GMAIL_CLIENT_ID)</label>
                  <input
                    type="text"
                    value={gmailOauth.clientId}
                    onChange={(e) => setGmailOauth({ ...gmailOauth, clientId: e.target.value })}
                    placeholder="xxxxxxxx.apps.googleusercontent.com"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Gmail Client Secret (GMAIL_CLIENT_SECRET)</label>
                  <input
                    type="password"
                    value={gmailOauth.clientSecret}
                    onChange={(e) => setGmailOauth({ ...gmailOauth, clientSecret: e.target.value })}
                    placeholder="GOCSPX-xxxxxxx"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-bold text-slate-700 mb-1">Redirect URI (GMAIL_REDIRECT_URI)</label>
                  <input
                    type="text"
                    value={gmailOauth.redirectUri}
                    onChange={(e) => setGmailOauth({ ...gmailOauth, redirectUri: e.target.value })}
                    placeholder="https://yourdomain.com/auth/google/callback"
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                  />
                </div>
              </div>
            </div>
`;
file = file.replace(emailSectionRegex, '$1' + gmailFields);


// 2. Add Google Calendar Toggle / API field
const calendarSectionRegex = /(<span className="text-slate-400">Timezone: Europe\/London \(GMT\+0\)<\/span>\s*<span className="font-bold text-blue-600">Auto-Booking Active<\/span>\s*<\/div>)/;

const calendarFields = `
            <div className="pt-4 border-t border-slate-100 mt-4 space-y-3">
               <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">Enable Real-Time Calendar API Sync</label>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <input 
                      type="checkbox" 
                      checked={calendarConfig.enabled}
                      onChange={(e) => setCalendarConfig({ ...calendarConfig, enabled: e.target.checked })}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" 
                    />
                    <span className="text-slate-600">Share availability logic with Google Workspace credentials</span>
                  </div>
               </div>
            </div>
`;
file = file.replace(calendarSectionRegex, '$1' + calendarFields);

fs.writeFileSync('src/pages/IntegrationsView.tsx', file);
console.log("Successfully enhanced Integrations.");
