import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Send, X } from "lucide-react";
import { apiFetch, readApiError } from "../lib/apiFetch";

/**
 * ENROL SELECTED CONTACTS INTO A CAMPAIGN.
 *
 * WHAT THIS REPLACES
 * ------------------
 * A banner reading "Successfully queued outreach sequences for 12 leads!", produced by a
 * handler that set `status: "CONTACTED"` in React state and called no endpoint at all. Nothing
 * was queued, nothing was persisted, and a refresh undid it. A leads list has never had a way
 * to put anyone into a campaign.
 *
 * WHAT IT DOES INSTEAD
 * --------------------
 * Calls `POST /api/campaigns/:id/recipients` and reports EXACTLY what came back, per contact.
 * The interesting half is the refusals: a contact who has unsubscribed, or whose lawful basis
 * is incomplete, is not enrolled — and the operator is told which, by name, rather than being
 * shown a count that quietly excluded them.
 */

interface CampaignSummary {
  id: string;
  name?: string;
  status?: string;
}

interface EnrolResult {
  contactId: string;
  outcome: string;
  reason?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  contactIds: string[];
  onEnrolled?: () => void;
}

export const EnrolInCampaignModal: React.FC<Props> = ({ isOpen, onClose, contactIds, onEnrolled }) => {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<EnrolResult[] | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setResults(null);
    void (async () => {
      try {
        const res = await apiFetch("/api/campaigns");
        if (!res.ok) {
          setError((await readApiError(res)).message);
          return;
        }
        const body = await res.json();
        const list: CampaignSummary[] = Array.isArray(body) ? body : (body?.campaigns ?? []);
        setCampaigns(list);
        if (list.length > 0) setCampaignId(list[0].id);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [isOpen]);

  if (!isOpen) return null;

  const enrol = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/campaigns/${encodeURIComponent(campaignId)}/recipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: contactIds.slice(0, 500) }),
      });
      if (!res.ok) {
        setError((await readApiError(res)).message);
        return;
      }
      const body = (await res.json()) as { results: EnrolResult[] };
      setResults(body.results ?? []);
      onEnrolled?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enrolled = (results ?? []).filter((r) => r.outcome === "ENROLLED");
  const refused = (results ?? []).filter((r) => r.outcome !== "ENROLLED");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden text-slate-100">
        <div className="p-5 border-b border-slate-800/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Send className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">Enrol in a campaign</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {contactIds.length} contact(s) selected
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 p-2 rounded-xl">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {results === null && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Campaign
                </label>
                {campaigns.length === 0 ? (
                  <p className="text-xs text-slate-400">
                    No campaigns exist yet. Create one first — enrolment attaches contacts to a
                    campaign, it does not create one.
                  </p>
                ) : (
                  <select
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100"
                  >
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name ?? c.id} {c.status ? `— ${c.status}` : ""}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Enrolling does not send anything. A contact whose lawful basis is incomplete, or
                who has unsubscribed, will be refused here and named below rather than quietly
                left out of the count.
              </p>
            </>
          )}

          {error !== null && (
            <div className="bg-rose-950/30 border border-rose-800/50 rounded-xl p-3 flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-rose-200 leading-relaxed">{error}</p>
            </div>
          )}

          {results !== null && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-emerald-300">
                <CheckCircle2 className="w-4 h-4" />
                {enrolled.length} enrolled, {refused.length} refused
              </div>
              {refused.length > 0 && (
                <div className="max-h-56 overflow-y-auto space-y-1.5">
                  {refused.map((r) => (
                    <div key={r.contactId} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                      <span className="text-[11px] font-mono text-amber-400">{r.outcome}</span>
                      <span className="text-xs text-slate-400 ml-2">
                        {r.contactId}
                        {r.reason ? ` — ${r.reason}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-800/80 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white hover:bg-slate-800/60 rounded-xl"
          >
            {results === null ? "Cancel" : "Close"}
          </button>
          {results === null && (
            <button
              onClick={() => void enrol()}
              disabled={busy || campaignId === "" || contactIds.length === 0}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl disabled:opacity-40 flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Enrol {contactIds.length} contact(s)
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
