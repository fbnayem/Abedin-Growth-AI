import React, { useEffect, useState } from "react";
import { HelpCircle, Loader2, RefreshCw } from "lucide-react";
import { apiFetch, readApiError } from "../lib/apiFetch";

/**
 * A SCORE, WITH HOW MUCH OF IT WAS MEASURED.
 *
 * WHAT THIS REPLACES
 * ------------------
 *     <div>{lead.aiScore}/100</div>
 *     <div>{lead.scoreBreakdown?.reasons?.[0] || "High fit clinic profile with evening call volume"}</div>
 *
 * Two problems in four lines. The number was produced from a loop index, and the explanation
 * had a hard-coded fallback — so a lead with no reasons at all displayed a sentence about
 * evening call volume that nobody had established about anybody.
 *
 * WHY THE CONFIDENCE IS AS LARGE AS THE SCORE HERE
 * -----------------------------------------------
 * `aiScore` is the percentage of the ASSESSABLE points a contact earned, not a mark out of 100,
 * and the two render identically. A record scored 90 on the ten points of contactability alone
 * looks exactly like one that was researched thoroughly and came out at 90. So the two numbers
 * are shown at the same weight, and the components that could not be assessed are listed by
 * name — because "we did not know" is the finding, for most leads, most of the time.
 */

interface Component {
  key: string;
  max: number;
  score: number | null;
  why: string;
}

interface Score {
  rubricVersion: string;
  components: Component[];
  earned: number;
  assessable: number;
  score: number;
  confidence: number;
  notScored: string[];
  signals: string[];
  risks: string[];
}

const HUMAN: Record<string, string> = {
  icpFit: "Fit with your ideal customer profile",
  painProbability: "Evidence they have the problem",
  intent: "Signals of interest",
  decisionMakerQuality: "Seniority of the contact",
  contactability: "Whether they can be contacted",
};

export const LeadScoreCard: React.FC<{ contactId: string; storedScore?: number | null; storedConfidence?: number | null }> = ({
  contactId,
  storedScore,
  storedConfidence,
}) => {
  const [score, setScore] = useState<Score | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/leads/${encodeURIComponent(contactId)}/score`);
      if (!res.ok) {
        setError((await readApiError(res)).message);
        return;
      }
      setScore((await res.json()) as Score);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setScore(null);
    setOpen(false);
  }, [contactId]);

  const shown = score?.score ?? storedScore ?? null;
  const confidence = score?.confidence ?? storedConfidence ?? null;

  return (
    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
      <div className="flex items-start justify-between gap-4">
        <div className="flex gap-6">
          <div>
            <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Score</div>
            <div className="text-2xl font-black text-slate-900">
              {shown === null ? "—" : shown}
              {shown !== null && <span className="text-sm font-bold text-slate-400">/100</span>}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">of what could be assessed</div>
          </div>
          <div>
            <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Confidence</div>
            <div
              className={`text-2xl font-black ${
                confidence === null ? "text-slate-400" : confidence >= 70 ? "text-emerald-700" : "text-amber-600"
              }`}
            >
              {confidence === null ? "—" : `${confidence}%`}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">of the rubric was measurable</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={() => {
              setOpen(true);
              void load();
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 transition-colors flex items-center gap-1"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <HelpCircle className="w-3.5 h-3.5" />}
            <span>Explain</span>
          </button>
          {score !== null && (
            <button
              onClick={() => void load()}
              className="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1"
            >
              <RefreshCw className="w-3 h-3" />
              Recompute
            </button>
          )}
        </div>
      </div>

      {shown === null && !open && (
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
          Not scored yet. Nothing is guessed in the meantime: a missing score is shown as missing
          rather than as a middle value.
        </p>
      )}

      {error !== null && (
        <p className="text-xs text-rose-700 mt-3 leading-relaxed">{error}</p>
      )}

      {open && score !== null && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>
              {score.earned} of {score.assessable} assessable points
            </span>
            <span className="font-mono">{score.rubricVersion}</span>
          </div>
          {score.components.map((c) => (
            <div key={c.key} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-800">{HUMAN[c.key] ?? c.key}</span>
                <span
                  className={`text-xs font-bold ${c.score === null ? "text-slate-400" : "text-slate-900"}`}
                >
                  {c.score === null ? "not scored" : `${c.score}/${c.max}`}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">{c.why}</p>
            </div>
          ))}
          {score.notScored.length > 0 && (
            <p className="text-[11px] text-amber-700 leading-relaxed">
              {score.notScored.length} of 5 components had no input on this record and were left
              out of the total rather than given a default. That is why the confidence is{" "}
              {score.confidence}%.
            </p>
          )}
        </div>
      )}
    </div>
  );
};
