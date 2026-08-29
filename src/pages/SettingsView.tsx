import React, { useState } from "react";
import {
  Settings,
  ShieldCheck,
  ShieldAlert,
  Save,
  CheckCircle2,
  Sliders,
  AlertTriangle,
  UserCheck,
  Lock,
  ListFilter,
  FileCode,
} from "lucide-react";
import { AutopilotSettings, AIRunLog } from "../types";

interface SettingsViewProps {
  settings: AutopilotSettings;
  onUpdateSettings: (newSettings: AutopilotSettings) => void;
  logs: AIRunLog[];
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  onUpdateSettings,
  logs,
}) => {
  const [localSettings, setLocalSettings] = useState<AutopilotSettings>(settings);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    onUpdateSettings(localSettings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Title */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">System & AI Safety Settings</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-800 font-bold">
              Policy Engine v2
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Configure autonomy levels, safety thresholds, rate limits, and review audit logs.
          </p>
        </div>

        <button
          onClick={handleSave}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 shadow-sm transition-colors"
        >
          <Save className="w-3.5 h-3.5" />
          <span>{saved ? "Saved Changes!" : "Save Configuration"}</span>
        </button>
      </div>

      {/* Autonomy Level Card */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
        <div className="flex items-center gap-2">
          <Sliders className="w-5 h-5 text-blue-600" />
          <div>
            <h3 className="text-sm font-bold text-slate-900">Autopilot Autonomy Level</h3>
            <p className="text-xs text-slate-500">
              Select how much autonomy Gemini agents have when sending emails and scheduling meetings.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {[
            {
              id: "ASSISTED",
              title: "Assisted (Copilot)",
              desc: "AI drafts all sequences and replies. Every action requires 1-click human approval before sending.",
              badge: "Strict Safety",
            },
            {
              id: "SEMI_AUTONOMOUS",
              title: "Semi-Autonomous (Recommended)",
              desc: "AI sends standard cold outreach and standard FAQ replies automatically. High-value replies and investor queries pause for your review.",
              badge: "Optimal Scale",
            },
            {
              id: "FULLY_AUTONOMOUS",
              title: "Fully Autonomous",
              desc: "AI autonomously handles outreach, responds to positive inquiries, and directly books calendar demos.",
              badge: "High Velocity",
            },
          ].map((mode) => (
            <div
              key={mode.id}
              onClick={() =>
                setLocalSettings({ ...localSettings, autonomyLevel: mode.id as any })
              }
              className={`p-4 rounded-xl border cursor-pointer transition-all space-y-2 ${
                localSettings.autonomyLevel === mode.id
                  ? "bg-blue-50/70 border-blue-600 shadow-xs ring-1 ring-blue-500"
                  : "bg-slate-50/60 border-slate-200 hover:border-slate-300"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-900">{mode.title}</span>
                <span className="text-[10px] font-semibold px-1.5 py-0.2 rounded bg-blue-100 text-blue-800">
                  {mode.badge}
                </span>
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">{mode.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Safety Policy Rules & Thresholds */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-600" />
          <h3 className="text-sm font-bold text-slate-900">Safety & Compliance Policy Rules</h3>
        </div>

        <div className="space-y-3">
          <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={localSettings.requireApprovalForInvestors}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  requireApprovalForInvestors: e.target.checked,
                })
              }
              className="mt-0.5"
            />
            <div className="text-xs">
              <span className="font-bold text-slate-900">Require Founder Approval for Investor Negotiations</span>
              <p className="text-slate-500">
                Any dialogue mentioning valuation, check size, or equity terms will automatically trigger a human review alert.
              </p>
            </div>
          </label>

          <label className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200 cursor-pointer">
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
          </label>

          {/* Daily 100 Emails Cap & Rate Limiting */}
          <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Lock className="w-4 h-4 text-blue-600" />
                <span className="text-xs font-bold text-slate-900">
                  Daily Outbound Email Safety Cap (Max 100 / Day)
                </span>
              </div>
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                {localSettings.dailyEmailSendingLimit || localSettings.maxOutreachPerDay || 100} emails/day
              </span>
            </div>
            <p className="text-xs text-slate-500">
              The continuous daily runner will stop immediately once 100 emails are reached each calendar day to protect your domain reputation.
            </p>
            <input
              type="range"
              min="10"
              max="100"
              step="5"
              value={localSettings.dailyEmailSendingLimit || localSettings.maxOutreachPerDay || 100}
              onChange={(e) =>
                setLocalSettings({
                  ...localSettings,
                  dailyEmailSendingLimit: parseInt(e.target.value, 10),
                  maxOutreachPerDay: parseInt(e.target.value, 10),
                })
              }
              className="w-full accent-blue-600 cursor-pointer"
            />
            <div className="flex justify-between text-[10px] text-slate-400 font-mono">
              <span>10 emails/day</span>
              <span>50 emails/day</span>
              <span className="font-bold text-slate-700">100 emails/day (User Ceiling)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <FileCode className="w-5 h-5 text-slate-600" />
            <h3 className="text-sm font-bold text-slate-900">AI Execution Audit Logs</h3>
          </div>
          <span className="text-xs text-slate-400">Showing recent agent runs</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 uppercase tracking-wider font-bold">
              <tr>
                <th className="py-2.5 px-3">Agent</th>
                <th className="py-2.5 px-3">Action</th>
                <th className="py-2.5 px-3">Status</th>
                <th className="py-2.5 px-3">Summary</th>
                <th className="py-2.5 px-3 text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {logs.slice(0, 5).map((log) => (
                <tr key={log.id} className="hover:bg-slate-50">
                  <td className="py-2 px-3 font-semibold text-slate-900">{log.agentType}</td>
                  <td className="py-2 px-3 text-slate-600">{log.actionType}</td>
                  <td className="py-2 px-3">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">
                      {log.status}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-slate-700 font-sans max-w-xs truncate">
                    {log.summary}
                  </td>
                  <td className="py-2 px-3 text-right text-slate-400 text-[11px]">
                    {new Date(log.createdAt).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
