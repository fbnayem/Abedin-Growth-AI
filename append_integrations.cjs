const fs = require('fs');

let file = fs.readFileSync('src/pages/IntegrationsView.tsx', 'utf8');

const injection = `
      {/* DATABASE INTEGRATION */}
      {(activeTab === "ALL" || activeTab === "DATABASE") && (
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-5">
          <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
            <div className="p-3 rounded-2xl bg-emerald-100 text-emerald-600">
              <Database className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">PostgreSQL Database (Cloud SQL)</h2>
              <p className="text-xs text-slate-500 mt-0.5">Primary durable store for contacts, conversations, and outbox.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3 col-span-2">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Database Connection String (DATABASE_URL)</label>
                <input
                  type="password"
                  value={dbConfig.url}
                  onChange={(e) => setDbConfig({ ...dbConfig, url: e.target.value })}
                  placeholder="postgresql://user:password@host:port/dbname"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                />
              </div>
            </div>
          </div>
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end">
            <button className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-colors">Save Database Config</button>
          </div>
        </div>
      )}

      {/* QUEUE INTEGRATION */}
      {(activeTab === "ALL" || activeTab === "QUEUE") && (
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-5">
          <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
            <div className="p-3 rounded-2xl bg-rose-100 text-rose-600">
              <Sliders className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Background Job Queue (Redis)</h2>
              <p className="text-xs text-slate-500 mt-0.5">Manages the transactional outbox and delay sequences.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-3 col-span-2">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Redis URL (REDIS_URL)</label>
                <input
                  type="password"
                  value={redisConfig.url}
                  onChange={(e) => setRedisConfig({ ...redisConfig, url: e.target.value })}
                  placeholder="redis://:password@host:port"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
                />
              </div>
            </div>
          </div>
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end">
            <button className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-colors">Save Queue Config</button>
          </div>
        </div>
      )}

      {/* PAYMENTS INTEGRATION */}
      {(activeTab === "ALL" || activeTab === "PAYMENTS") && (
        <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-5">
          <div className="flex items-center gap-3 pb-4 border-b border-slate-100">
            <div className="p-3 rounded-2xl bg-indigo-100 text-indigo-600">
              <Tag className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-base font-bold text-slate-900">Stripe Payments</h2>
              <p className="text-xs text-slate-500 mt-0.5">Secure checkout sessions and billing sync.</p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Stripe Secret Key (STRIPE_SECRET_KEY)</label>
              <input
                type="password"
                value={stripeConfig.secretKey}
                onChange={(e) => setStripeConfig({ ...stripeConfig, secretKey: e.target.value })}
                placeholder="sk_test_..."
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Stripe Webhook Secret (STRIPE_WEBHOOK_SECRET)</label>
              <input
                type="password"
                value={stripeConfig.webhookSecret}
                onChange={(e) => setStripeConfig({ ...stripeConfig, webhookSecret: e.target.value })}
                placeholder="whsec_..."
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-hidden font-medium font-mono"
              />
            </div>
          </div>
          <div className="pt-4 border-t border-slate-100 flex items-center justify-end">
            <button className="px-4 py-2 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 transition-colors">Save Payments Config</button>
          </div>
        </div>
      )}
`;

const targetString = '    </div>\n  );\n};\n';

if (file.includes(targetString)) {
  file = file.replace(targetString, injection + '\n' + targetString);
  fs.writeFileSync('src/pages/IntegrationsView.tsx', file);
  console.log("Successfully appended new sections.");
} else {
  console.log("Could not find the end of the file!");
}
