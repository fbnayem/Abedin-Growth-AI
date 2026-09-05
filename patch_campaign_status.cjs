const fs = require('fs');
let code = fs.readFileSync('src/pages/CampaignsView.tsx', 'utf8');

const oldBadge = `                  <span
                    className={\`text-[10px] font-bold px-2 py-0.5 rounded-full \${
                      camp.status === "ACTIVE"
                        ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                        : "bg-slate-100 text-slate-600"
                    }\`}
                  >
                    {camp.status}
                  </span>`;

const newBadge = `                  <span
                    className={\`text-[10px] font-bold px-2 py-0.5 rounded-full border \${
                      camp.status === "ACTIVE"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : camp.status === "PAUSED"
                        ? "bg-amber-50 text-amber-700 border-amber-200"
                        : camp.status === "COMPLETED"
                        ? "bg-slate-100 text-slate-700 border-slate-200"
                        : "bg-slate-50 text-slate-500 border-slate-200" // DRAFT or other
                    }\`}
                  >
                    {camp.status}
                  </span>`;

code = code.replace(oldBadge, newBadge);

// Let's do a global replace in case there are multiple
code = code.split(oldBadge).join(newBadge);

fs.writeFileSync('src/pages/CampaignsView.tsx', code);
