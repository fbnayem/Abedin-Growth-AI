import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSignature,
  HelpCircle,
  Loader2,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { apiFetch } from "../lib/apiFetch";

/**
 * WHAT IS STILL BLOCKING A REAL SEND, AND THE ASSESSMENTS THAT BACK IT.
 *
 * The question an operator actually has is not "is the send flag on" — it is "if I turned it on
 * right now, what would happen?". Before this view the answer lived across seven environment
 * flags, an OAuth record, a DNS lookup, a settings document, a country table, a set of campaign
 * guards and a lawful basis on every contact. This shows the computed answer.
 *
 * THE DESIGN RULE WORTH KEEPING
 * -----------------------------
 * UNKNOWN is rendered as blocking, in amber rather than green, and never collapsed into "fine".
 * A check whose input could not be read has not passed, and a readiness screen that renders a
 * datastore blip as a tick is worse than no screen at all — because people act on it.
 *
 * The page also renders what the report CANNOT check. A readiness view that quietly scopes
 * itself to its own measurements is how "ready" comes to mean "ready in the ways we tested".
 */

type CheckStatus = "PASS" | "BLOCK" | "UNKNOWN" | "WARN";

interface PreflightCheck {
  id: string;
  question: string;
  status: CheckStatus;
  finding: string;
  remedy: string | null;
  blocking: boolean;
}

interface Preflight {
  ready: boolean;
  checks: PreflightCheck[];
  blocking: PreflightCheck[];
  uncheckable: string[];
}

interface Assessment {
  id: string;
  title: string;
  countries: string[];
  createdBy: string;
  createdAt: string;
  signedBy: string | null;
  signedAt: string | null;
  reviewDueAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  usable: boolean;
  whyNotUsable: string | null;
}

const card = "bg-slate-900/60 border border-slate-700/60 rounded-2xl p-5";

const STATUS_STYLE: Record<CheckStatus, { icon: typeof CheckCircle2; tone: string; label: string }> = {
  PASS: { icon: CheckCircle2, tone: "text-emerald-400", label: "Ready" },
  BLOCK: { icon: XCircle, tone: "text-rose-400", label: "Blocking" },
  // Amber, not green, and it counts as blocking. See the header.
  UNKNOWN: { icon: HelpCircle, tone: "text-amber-400", label: "Could not check" },
  WARN: { icon: AlertTriangle, tone: "text-amber-400", label: "Worth knowing" },
};

function CheckRow({ check, children }: { check: PreflightCheck; children?: React.ReactNode }) {
  const style = STATUS_STYLE[check.status];
  const Icon = style.icon;
  return (
    <div className="flex items-start gap-3 py-3.5 border-b border-slate-800/60 last:border-b-0">
      <Icon className={`w-4 h-4 flex-shrink-0 mt-0.5 ${style.tone}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-xs font-medium text-white">{check.question}</p>
          <span className={`text-[10px] uppercase tracking-wide ${style.tone}`}>{style.label}</span>
        </div>
        <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{check.finding}</p>
        {check.remedy !== null && (
          <p className="text-xs text-sky-300/80 mt-1.5 leading-relaxed">{check.remedy}</p>
        )}
        {children}
      </div>
    </div>
  );
}

/**
 * THE CONTROLLER IDENTITY, WHICH THE PAGE REPORTED AND COULD NOT FIX.
 *
 * `readControllerIdentity` reads these seven out of the settings document, and until this form
 * existed nothing in the repository wrote them — `settingsSchema` is `.strict()` and named none of
 * them, so the only write path refused all seven. The preflight's own remedy line said "POST the
 * missing fields to /api/settings", which was an instruction to use a door with no handle.
 *
 * The form lives here rather than on the settings page for a reason beyond convenience: the
 * settings page posts to `/api/settings/autopilot`, which is a deliberate NOT_IMPLEMENTED refusal,
 * and never touches `/api/settings` at all. Putting the fields where the gap is REPORTED means the
 * operator reads what is missing and fixes it without changing screens — and the check turning
 * green on the reload IS the confirmation, so there is no success banner here that could be wrong.
 */
const CONTROLLER_FIELDS: readonly {
  key: string;
  label: string;
  hint: string;
  placeholder: string;
  long?: true;
}[] = [
  {
    key: "controllerName",
    label: "Controller name",
    hint: "The legal entity that decides why this data is processed — not a trading name, if they differ.",
    placeholder: "Abedin Ltd",
  },
  {
    key: "controllerPostalAddress",
    label: "Postal address",
    hint: "A real address. Article 14 asks for it and CAN-SPAM requires one in every commercial message.",
    placeholder: "1 Example Street, London, EC1A 1AA, United Kingdom",
    long: true,
  },
  {
    key: "controllerContactEmail",
    label: "Contact email",
    hint: "Where a person can reach a human about their data. Monitored by someone.",
    placeholder: "privacy@abedin.example",
  },
  {
    key: "privacyPolicyUrl",
    label: "Privacy policy URL",
    hint: "Quoted in the notice, so it must resolve. A malformed one is refused here rather than sent to a stranger.",
    placeholder: "https://abedin.example/privacy",
  },
  {
    key: "retentionPolicy",
    label: "How long records are kept",
    hint: "Quoted verbatim to the recipient. Nothing enforces it yet — it is a promise kept by hand until the retention sweep exists.",
    placeholder: "Twelve months from last contact, then deleted.",
    long: true,
  },
  {
    key: "supervisoryAuthority",
    label: "Supervisory authority",
    hint: "Which regulator a person may complain to, and how to reach them.",
    placeholder: "The Information Commissioner's Office — ico.org.uk/make-a-complaint",
    long: true,
  },
  {
    key: "dpoContact",
    label: "Data protection contact",
    hint: "Required even with no DPO appointed. Absent and “none appointed” are different facts, and only one of them is a configured system — so write the sentence rather than leaving it blank.",
    placeholder: "No data protection officer is appointed. Contact privacy@abedin.example.",
    long: true,
  },
];

function ControllerIdentityForm({ onSaved }: { onSaved: () => Promise<void> | void }) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [version, setVersion] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Read the current document before offering to edit it. A form that opened empty would invite
  // an operator to blank a field they never meant to touch — and this route merges, so a field
  // they leave out is kept rather than cleared.
  const open_ = useCallback(async () => {
    setOpen(true);
    setProblem(null);
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) {
        setProblem("The current settings could not be read, so this form will not guess at them.");
        return;
      }
      const body = await res.json();
      const next: Record<string, string> = {};
      for (const f of CONTROLLER_FIELDS) {
        next[f.key] = typeof body?.[f.key] === "string" ? body[f.key] : "";
      }
      setValues(next);
      setVersion(typeof body?.version === "number" ? body.version : 0);
    } catch {
      setProblem("The current settings could not be read, so this form will not guess at them.");
    }
  }, []);

  const save = useCallback(async () => {
    if (values === null) return;
    setSaving(true);
    setProblem(null);
    try {
      // Only non-empty fields are sent. The route merges, so omitting a field leaves the stored
      // value alone; sending "" would fail `.min(1)` and refuse the whole save because of a box
      // the operator had not got to yet.
      const payload: Record<string, string> = {};
      for (const f of CONTROLLER_FIELDS) {
        const v = (values[f.key] ?? "").trim();
        if (v !== "") payload[f.key] = v;
      }
      if (Object.keys(payload).length === 0) {
        setProblem("Nothing to save yet.");
        return;
      }
      const res = await apiFetch("/api/settings", {
        method: "POST",
        // P1.3 — the version travels with the write, or a concurrent edit is discarded silently.
        headers: { "Content-Type": "application/json", "If-Match": String(version) },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setProblem(body?.error?.message ?? "The save was refused and the reason could not be read.");
        return;
      }
      // No success message. The check above re-renders from live state, and a partial save is
      // progress rather than completion — saying "saved" would invite reading it as "done".
      await onSaved();
      setOpen(false);
      setValues(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "The save failed.");
    } finally {
      setSaving(false);
    }
  }, [values, version, onSaved]);

  if (!open) {
    return (
      <button
        onClick={() => void open_()}
        className="mt-2.5 text-xs font-medium text-sky-300 hover:text-sky-200 underline underline-offset-2"
      >
        Configure these here
      </button>
    );
  }

  return (
    <div className="mt-3 bg-slate-950/50 border border-slate-700/60 rounded-xl p-4">
      <p className="text-[11px] text-slate-400 leading-relaxed mb-3">
        Saved fields are merged, so you can fill in what you know now and come back. The check above
        stays blocking until all seven are present — it will name whatever is still missing.
      </p>
      {values === null && problem === null && (
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading current settings…
        </div>
      )}
      {values !== null && (
        <div className="space-y-3">
          {CONTROLLER_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="block text-[11px] font-medium text-slate-200">{f.label}</label>
              <p className="text-[10px] text-slate-500 leading-relaxed mt-0.5 mb-1">{f.hint}</p>
              {f.long === true ? (
                <textarea
                  rows={2}
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-600"
                />
              ) : (
                <input
                  value={values[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:border-sky-600"
                />
              )}
            </div>
          ))}
        </div>
      )}
      {problem !== null && (
        <p className="text-xs text-rose-300 mt-3 leading-relaxed">{problem}</p>
      )}
      <div className="flex items-center gap-2 mt-4">
        <button
          onClick={() => void save()}
          disabled={saving || values === null}
          className="text-xs font-medium bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
            setValues(null);
            setProblem(null);
          }}
          className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function OutreachReadinessView() {
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [assessments, setAssessments] = useState<Assessment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const [pre, lia] = await Promise.all([
        apiFetch("/api/outreach/preflight"),
        apiFetch("/api/lia"),
      ]);
      if (!pre.ok) {
        const body = await pre.json().catch(() => null);
        setError(body?.error?.message ?? "The readiness check could not be run.");
      } else {
        setPreflight(await pre.json());
      }
      // A failure to list assessments is reported as null rather than as an empty list: "none
      // exist" and "we could not look" are different answers and only one of them is good news.
      setAssessments(lia.ok ? ((await lia.json()).assessments ?? []) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The readiness check failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-white">Outreach readiness</h1>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed max-w-2xl">
            Not "is sending switched on" — what would actually happen if it were. Every check runs
            against live state, and anything that could not be read counts as blocking rather than
            as fine.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2 flex-shrink-0"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Re-check
        </button>
      </div>

      {error !== null && (
        <div className="bg-rose-950/30 border border-rose-800/50 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-rose-200 leading-relaxed">{error}</p>
        </div>
      )}

      {preflight !== null && (
        <>
          <div
            className={
              preflight.ready
                ? "bg-emerald-950/30 border border-emerald-800/50 rounded-2xl p-5"
                : "bg-amber-950/20 border border-amber-800/50 rounded-2xl p-5"
            }
          >
            <div className="flex items-start gap-3">
              {preflight.ready ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-400 flex-shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-sm font-semibold text-white">
                  {preflight.ready
                    ? "Every mechanical precondition is in place."
                    : `${preflight.blocking.length} thing${preflight.blocking.length === 1 ? "" : "s"} would stop a send right now.`}
                </p>
                <p className="text-xs text-slate-300/90 mt-2 leading-relaxed">
                  {preflight.ready
                    ? "That is not permission. It means the checks this system knows how to make have passed — not that the list is right, the copy is accurate, or the country rules have been read correctly by anybody."
                    : "Each is listed below with what to do about it. Nothing here is a bug; this is the expected state of a system that has never sent anything."}
                </p>
              </div>
            </div>
          </div>

          <div className={card}>
            <h2 className="text-sm font-semibold text-white mb-1">The checks</h2>
            <div className="mt-2">
              {preflight.checks.map((check) => (
                <CheckRow key={check.id} check={check}>
                  {check.id === "controller-identity" && check.status !== "PASS" && (
                    <ControllerIdentityForm onSaved={load} />
                  )}
                </CheckRow>
              ))}
            </div>
          </div>

          <div className={card}>
            <div className="flex items-center gap-2 mb-3">
              <HelpCircle className="w-4 h-4 text-slate-400" />
              <h2 className="text-sm font-semibold text-white">What this page cannot tell you</h2>
            </div>
            <ul className="space-y-2">
              {preflight.uncheckable.map((item) => (
                <li key={item} className="text-xs text-slate-400 leading-relaxed flex gap-2">
                  <span className="text-slate-600 flex-shrink-0">—</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className={card}>
        <div className="flex items-center gap-2 mb-3">
          <FileSignature className="w-4 h-4 text-sky-400" />
          <h2 className="text-sm font-semibold text-white">Balancing assessments</h2>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed">
          Every legitimate-interest contact cites one of these. With real sending on, the id has to
          resolve to a document that is signed, in date, not withdrawn, and covering that person's
          country — a draft supports nothing, and a signed one cannot be edited afterwards.
        </p>

        {assessments === null ? (
          <p className="text-xs text-amber-400/90 mt-4 leading-relaxed">
            The assessments could not be read, which is not the same as there being none.
          </p>
        ) : assessments.length === 0 ? (
          <p className="text-xs text-slate-400 mt-4 leading-relaxed">
            None yet. <span className="text-slate-300">docs/production/lia-uk-b2b-2026.md</span> is a
            drafted assessment to start from — read it properly before signing, because signing is
            what puts your name against the balancing judgement in it.
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            {assessments.map((a) => (
              <div
                key={a.id}
                className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-3.5 flex items-start gap-3"
              >
                {a.usable ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-4 h-4 text-slate-500 flex-shrink-0 mt-0.5" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-white">{a.title}</p>
                  <p className="text-[11px] text-slate-500 mt-1 font-mono">{a.id}</p>
                  <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
                    {a.countries.join(", ")} ·{" "}
                    {a.signedAt === null
                      ? `draft, written by ${a.createdBy}`
                      : `signed by ${a.signedBy} on ${a.signedAt.slice(0, 10)}`}
                    {a.reviewDueAt !== null && ` · review due ${a.reviewDueAt.slice(0, 10)}`}
                  </p>
                  {a.whyNotUsable !== null && (
                    <p className="text-xs text-amber-400/90 mt-1.5 leading-relaxed">{a.whyNotUsable}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
