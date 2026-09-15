import React, { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileSpreadsheet,
  Globe,
  Loader2,
  MailCheck,
  Search,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";
import { apiFetch, readApiError } from "../lib/apiFetch";

/**
 * LEAD SOURCES — the screen the lead generation work is operated from.
 *
 * WHAT THIS REPLACES
 * ------------------
 * Three "Discover with AI" modals that called an endpoint answering 501, above a paragraph
 * claiming every discovered lead was "checked against your company ICP brain, analyzed for
 * phone reliance and decision-maker seniority, and scored on a 0-100 scale". None of that
 * happened. This screen shows what each source actually does, including when the answer is
 * "nothing, because the flag is off".
 *
 * THE THING THIS SCREEN IS BUILT AROUND
 * ------------------------------------
 * IMPORTED AND CONTACTABLE ARE DIFFERENT NUMBERS, and both are shown, always. A run that
 * creates 412 records of which 9 can be emailed says so in two figures side by side. Showing
 * only the first is what makes a lead pipeline look like it is working right up until the first
 * campaign sends nine emails.
 *
 * Every source previews before it commits, and the preview's refusal list is the part worth
 * reading: it names the rows that will not become leads and why, before anything is written.
 */

type Tab = "import" | "discover" | "scrape" | "notice";

interface RowOutcome {
  line?: number;
  ref?: string;
  email: string;
  contactId: string;
  status: string;
  mailable: boolean;
  reason: string;
  refusalCode: string | null;
}

interface Counts {
  dataRows?: number;
  wouldCreate: number;
  created: number;
  duplicates: number;
  refused?: number;
  failed: number;
  mailable: number;
  notYetMailable?: number;
}

interface RunResult {
  mode: string;
  planHash?: string;
  batchId?: string;
  delimiter?: string;
  mappedColumns?: Record<string, string>;
  ignoredColumns?: string[];
  counts: Counts;
  outcomes: RowOutcome[];
  refused?: { line: number; code: string; message: string; email: string | null }[];
  rejected?: { ref?: string; providerRecordId?: string; code: string; message: string }[];
  pages?: { url: string; status: number; addressesFound: number; note: string }[];
  skipped?: { url: string; code: string; message: string }[];
  costMinor?: number;
  costIsUpperBound?: boolean;
  provider?: string;
  host?: string;
  userAgent?: string;
  returned?: number;
}

const BASES = [
  { value: "LEGITIMATE_INTEREST", label: "Legitimate interest (B2B)" },
  { value: "CONSENT", label: "Consent" },
];

const label = "block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5";
const input =
  "w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all";
const card = "bg-slate-900 border border-slate-800 rounded-2xl p-5";

/**
 * The two numbers, together.
 *
 * A component rather than two spans, so that adding a screen which shows one without the other
 * takes a deliberate decision rather than a copied line.
 */
const Outcome: React.FC<{ counts: Counts; committed: boolean }> = ({ counts, committed }) => {
  const made = committed ? counts.created : counts.wouldCreate;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
        <div className="text-2xl font-semibold text-slate-100">{made}</div>
        <div className="text-[11px] text-slate-400 mt-0.5">
          {committed ? "records created" : "records a commit would create"}
        </div>
      </div>
      <div className="bg-slate-950 border border-emerald-800/40 rounded-xl p-3">
        <div className="text-2xl font-semibold text-emerald-400">{counts.mailable}</div>
        <div className="text-[11px] text-slate-400 mt-0.5">of those, contactable today</div>
      </div>
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
        <div className="text-2xl font-semibold text-slate-300">{counts.duplicates}</div>
        <div className="text-[11px] text-slate-400 mt-0.5">already in the database, untouched</div>
      </div>
      <div className="bg-slate-950 border border-slate-800 rounded-xl p-3">
        <div className="text-2xl font-semibold text-amber-400">
          {(counts.refused ?? 0) + counts.failed}
        </div>
        <div className="text-[11px] text-slate-400 mt-0.5">refused, with a reason</div>
      </div>
    </div>
  );
};

/** Why each record cannot be emailed yet. The list an operator actually needs. */
const WhyNotMailable: React.FC<{ outcomes: RowOutcome[] }> = ({ outcomes }) => {
  const grouped = new Map<string, { count: number; reason: string }>();
  for (const o of outcomes) {
    if (o.mailable) continue;
    const key = o.refusalCode ?? "UNKNOWN";
    const entry = grouped.get(key);
    if (entry) entry.count += 1;
    else grouped.set(key, { count: 1, reason: o.reason });
  }
  if (grouped.size === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
        Why the rest cannot be emailed yet
      </h4>
      <div className="space-y-2">
        {[...grouped.entries()].map(([code, { count, reason }]) => (
          <div key={code} className="bg-slate-950 border border-slate-800 rounded-xl p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded">
                {code}
              </span>
              <span className="text-xs text-slate-400">{count} record(s)</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">{reason}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export const LeadSourcesView: React.FC<{ onImported?: () => void }> = ({ onImported }) => {
  const [tab, setTab] = useState<Tab>("import");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Shared batch settings — the lawful basis is one decision per run, never per row.
  const [basis, setBasis] = useState("LEGITIMATE_INTEREST");
  const [liaId, setLiaId] = useState("");
  const [country, setCountry] = useState("GB");
  const [sourceEvidence, setSourceEvidence] = useState("");
  const [consentEvidence, setConsentEvidence] = useState("");

  // Import
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("");

  // Discover
  const [industry, setIndustry] = useState("");
  const [titles, setTitles] = useState("");
  const [limit, setLimit] = useState(10);

  // Scrape
  const [url, setUrl] = useState("");
  const [pageBudget, setPageBudget] = useState(5);
  const [includePersonal, setIncludePersonal] = useState(false);

  const reset = () => {
    setError(null);
    setNotice(null);
  };

  const call = async (path: string, body: Record<string, unknown>): Promise<RunResult | null> => {
    setBusy(true);
    reset();
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const problem = await readApiError(res);
        setError(problem.message);
        setResult(null);
        return null;
      }
      const data = (await res.json()) as RunResult;
      setResult(data);
      return data;
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const batchFields = () => ({
    basis,
    liaId: liaId.trim() === "" ? undefined : liaId.trim(),
    country,
    sourceEvidence: sourceEvidence.trim(),
    consentEvidence: consentEvidence.trim() === "" ? undefined : consentEvidence.trim(),
  });

  const runImport = async (mode: "PREVIEW" | "COMMIT") => {
    const body: Record<string, unknown> = {
      mode,
      text,
      ...batchFields(),
    };
    if (mode === "COMMIT") {
      if (result?.planHash === undefined) {
        setError("Preview the file first. A commit has to name the plan that was approved.");
        return;
      }
      body.expectedPlanHash = result.planHash;
    }
    const outcome = await call("/api/leads/import", body);
    if (outcome !== null && mode === "COMMIT") onImported?.();
  };

  const runDiscover = async (mode: "PREVIEW" | "COMMIT") => {
    const outcome = await call("/api/leads/discover", {
      mode,
      country,
      industry: industry.trim() === "" ? undefined : industry.trim(),
      titles:
        titles.trim() === ""
          ? undefined
          : titles.split(",").map((t) => t.trim()).filter((t) => t !== ""),
      limit,
      basis,
      liaId: liaId.trim() === "" ? undefined : liaId.trim(),
      sourceEvidence: sourceEvidence.trim(),
    });
    if (outcome !== null && mode === "COMMIT") onImported?.();
  };

  const runScrape = async (mode: "PREVIEW" | "COMMIT") => {
    const outcome = await call("/api/leads/scrape", {
      mode,
      url: url.trim(),
      pageBudget,
      basis,
      liaId: liaId.trim() === "" ? undefined : liaId.trim(),
      country,
      sourceEvidence: sourceEvidence.trim(),
      includePersonalAddresses: includePersonal,
    });
    if (outcome !== null && mode === "COMMIT") onImported?.();
  };

  const runNotice = async () => {
    if (result === null) return;
    const contactIds = result.outcomes
      .filter((o) => o.refusalCode === "LI_NOTICE_NOT_SENT")
      .map((o) => o.contactId);
    if (contactIds.length === 0) {
      setError("No record in this run is waiting on the Article 14 notice.");
      return;
    }
    setBusy(true);
    reset();
    try {
      const res = await apiFetch("/api/leads/notice-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactIds: contactIds.slice(0, 500),
          evidence: sourceEvidence.trim() || "Article 14 notice sent from the lead sources console.",
        }),
      });
      if (!res.ok) {
        setError((await readApiError(res)).message);
        return;
      }
      const body = (await res.json()) as { recorded: number; unchanged: number; mailable: number };
      setNotice(
        `Recorded the notice against ${body.recorded} record(s); ${body.unchanged} already had ` +
          `one. ${body.mailable} are now contactable.`
      );
      onImported?.();
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
    setResult(null);
    if (sourceEvidence.trim() === "") setSourceEvidence(`Imported from ${file.name}`);
  };

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: "import", label: "Import a list", icon: FileSpreadsheet },
    { id: "discover", label: "Paid discovery", icon: Search },
    { id: "scrape", label: "Scrape a site", icon: Globe },
    { id: "notice", label: "Article 14 notice", icon: MailCheck },
  ];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-white">Lead sources</h1>
        <p className="text-sm text-slate-400 mt-1">
          Four ways in, one write path. Every source previews before it commits, nothing
          overwrites a contact that already exists, and no record becomes contactable until its
          lawful basis is complete.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setResult(null);
              reset();
            }}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
              tab === t.id
                ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-300"
                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* The lawful basis, shared by every source, stated once. */}
      <div className={card}>
        <div className="flex items-center gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <h2 className="text-sm font-semibold text-white">Lawful basis for this batch</h2>
        </div>
        <p className="text-xs text-slate-400 mb-4 leading-relaxed">
          One decision for the whole run, never read from the file. Legitimate interest is the
          business-to-business basis and needs a balancing assessment on file and the Article 14
          notice sent before anyone can be emailed. Consent needs evidence of where and when it
          was given.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <label className={label}>Basis</label>
            <select value={basis} onChange={(e) => setBasis(e.target.value)} className={input}>
              {BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={label}>Country (ISO-3166)</label>
            <input
              value={country}
              onChange={(e) => setCountry(e.target.value.toUpperCase())}
              maxLength={2}
              className={input}
              placeholder="GB"
            />
          </div>
          {basis === "LEGITIMATE_INTEREST" ? (
            <div>
              <label className={label}>Balancing assessment id</label>
              <input
                value={liaId}
                onChange={(e) => setLiaId(e.target.value)}
                className={input}
                placeholder="lia_2026_q3_uk_b2b"
              />
            </div>
          ) : (
            <div>
              <label className={label}>Consent evidence</label>
              <input
                value={consentEvidence}
                onChange={(e) => setConsentEvidence(e.target.value)}
                className={input}
                placeholder="webform:pricing-page, 2026-08-01"
              />
            </div>
          )}
          <div className="sm:col-span-2 lg:col-span-1">
            <label className={label}>Where this batch came from</label>
            <input
              value={sourceEvidence}
              onChange={(e) => setSourceEvidence(e.target.value)}
              className={input}
              placeholder="Northwind Events attendee list, Sept 2026"
            />
          </div>
        </div>
      </div>

      {tab === "import" && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-4">
            <Upload className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Import a CSV or a pasted list</h2>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <label className={label}>Choose a file</label>
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/plain"
                onChange={(e) => void onFile(e.target.files?.[0])}
                className="block w-full text-xs text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
              />
              {fileName !== "" && (
                <p className="text-[11px] text-slate-500 mt-2">
                  {fileName} — {text.length.toLocaleString()} characters
                </p>
              )}
            </div>
            <div>
              <label className={label}>…or paste the rows</label>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setResult(null);
                }}
                rows={5}
                className={`${input} font-mono text-xs`}
                placeholder={"email,firstName,companyName,country\njane@acme.example,Jane,Acme,GB"}
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-3 leading-relaxed">
            The first row is the header. Columns are matched against a fixed list of fields —
            anything unrecognised is reported and ignored, never guessed at, and a column named
            after a consent or suppression field writes nothing.
          </p>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => void runImport("PREVIEW")}
              disabled={busy || text.trim() === ""}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-xs rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Preview — writes nothing
            </button>
            <button
              onClick={() => void runImport("COMMIT")}
              disabled={busy || result?.planHash === undefined}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2"
              title={
                result?.planHash === undefined
                  ? "Preview first: a commit has to name the plan that was approved."
                  : undefined
              }
            >
              <CheckCircle2 className="w-4 h-4" />
              Import these rows
            </button>
          </div>
        </div>
      )}

      {tab === "discover" && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-4">
            <Search className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Buy records from a discovery provider</h2>
          </div>
          <p className="text-xs text-slate-400 mb-4 leading-relaxed">
            Off unless <span className="font-mono text-slate-300">REAL_DISCOVERY_ENABLED</span> is
            set and an adapter is registered. Every lookup is charged against this
            organisation&rsquo;s daily and monthly spend cap, and a lookup that times out is
            recorded at a ceiling rather than retried — it may already have been billed.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={label}>Industry</label>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} className={input} placeholder="Dental practices" />
            </div>
            <div>
              <label className={label}>Job titles (comma separated)</label>
              <input value={titles} onChange={(e) => setTitles(e.target.value)} className={input} placeholder="Practice Owner, Practice Manager" />
            </div>
            <div>
              <label className={label}>How many</label>
              <input
                type="number"
                min={1}
                max={200}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
                className={input}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => void runDiscover("PREVIEW")}
              disabled={busy}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-xs rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Search — the lookup is charged either way
            </button>
            <button
              onClick={() => void runDiscover("COMMIT")}
              disabled={busy}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" />
              Search and keep the records
            </button>
          </div>
        </div>
      )}

      {tab === "scrape" && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-4">
            <Globe className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Read a company&rsquo;s published contact details</h2>
          </div>
          <p className="text-xs text-slate-400 mb-4 leading-relaxed">
            Off unless <span className="font-mono text-slate-300">REAL_SCRAPE_ENABLED</span> is
            set. One site per run. robots.txt is honoured, requests are spaced, the crawler
            identifies itself, and only role addresses such as <span className="font-mono">info@</span>{" "}
            are taken unless you ask otherwise.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className={label}>Start URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} className={input} placeholder="https://example.com/contact" />
            </div>
            <div>
              <label className={label}>Pages at most</label>
              <input
                type="number"
                min={1}
                max={20}
                value={pageBudget}
                onChange={(e) => setPageBudget(Number(e.target.value))}
                className={input}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 mt-3 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={includePersonal}
              onChange={(e) => setIncludePersonal(e.target.checked)}
              className="rounded border-slate-700 bg-slate-950"
            />
            Also take addresses that look like a named individual — a different category of
            personal data from a published role address
          </label>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => void runScrape("PREVIEW")}
              disabled={busy || url.trim() === ""}
              className="px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-100 font-medium text-xs rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Read the site — writes nothing
            </button>
            <button
              onClick={() => void runScrape("COMMIT")}
              disabled={busy || url.trim() === ""}
              className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" />
              Read and keep what it finds
            </button>
          </div>
        </div>
      )}

      {tab === "notice" && (
        <div className={card}>
          <div className="flex items-center gap-2 mb-4">
            <MailCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-white">Record that the Article 14 notice has been sent</h2>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Where a record was collected indirectly — imported, purchased or scraped — the person
            has to be told where their data came from before or at first contact. Until that is
            recorded, legitimate interest refuses and nobody in the batch can be emailed.
          </p>
          <p className="text-xs text-amber-400/90 mt-3 leading-relaxed">
            This records that you have sent the notice. It does not send it, and the timestamp is
            the moment you press the button rather than a date you can type — a date nothing can
            check is not evidence.
          </p>
          <button
            onClick={() => void runNotice()}
            disabled={busy || result === null}
            className="mt-4 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs rounded-xl transition-colors disabled:opacity-40 flex items-center gap-2"
            title={result === null ? "Run an import, search or scrape first." : undefined}
          >
            <MailCheck className="w-4 h-4" />
            I have sent the notice to everyone in the last run
          </button>
        </div>
      )}

      {error !== null && (
        <div className="bg-rose-950/30 border border-rose-800/50 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-rose-200 leading-relaxed">{error}</p>
        </div>
      )}

      {notice !== null && (
        <div className="bg-emerald-950/30 border border-emerald-800/50 rounded-2xl p-4 flex items-start gap-3">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-emerald-200 leading-relaxed">{notice}</p>
        </div>
      )}

      {result !== null && (
        <div className={card}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-white">
              {result.mode === "COMMIT" ? "What happened" : "What a commit would do"}
            </h2>
            {result.costMinor !== undefined && (
              <span className="text-[11px] text-slate-400">
                Cost: {(result.costMinor / 100).toFixed(2)} USD
                {result.costIsUpperBound ? " (an upper bound)" : ""}
              </span>
            )}
          </div>

          <Outcome counts={result.counts} committed={result.mode === "COMMIT"} />
          <WhyNotMailable outcomes={result.outcomes} />

          {result.ignoredColumns !== undefined && result.ignoredColumns.length > 0 && (
            <div className="mt-4 bg-slate-950 border border-amber-800/40 rounded-xl p-3">
              <p className="text-xs text-amber-300">
                Columns that matched no field and were ignored:{" "}
                <span className="font-mono">{result.ignoredColumns.join(", ")}</span>
              </p>
            </div>
          )}

          {result.refused !== undefined && result.refused.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Rows that will not become leads
              </h4>
              <div className="max-h-64 overflow-y-auto space-y-1.5">
                {result.refused.map((r, i) => (
                  <div key={i} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2">
                    <span className="text-[11px] font-mono text-amber-400">line {r.line}</span>
                    <span className="text-[11px] text-slate-500 mx-2">{r.code}</span>
                    <span className="text-xs text-slate-400">{r.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.pages !== undefined && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Pages read ({result.userAgent})
              </h4>
              <div className="space-y-1.5">
                {result.pages.map((p) => (
                  <div key={p.url} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-400">
                    <span className="font-mono text-slate-300">{p.status}</span> {p.url} —{" "}
                    {p.addressesFound} address(es). {p.note}
                  </div>
                ))}
                {(result.skipped ?? []).map((s, i) => (
                  <div key={i} className="bg-slate-950 border border-amber-800/40 rounded-lg px-3 py-2 text-xs text-amber-300/90">
                    skipped {s.url} — {s.code}: {s.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {(result.rejected ?? []).length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Records the system refused
              </h4>
              <div className="max-h-48 overflow-y-auto space-y-1.5">
                {(result.rejected ?? []).map((r, i) => (
                  <div key={i} className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-400">
                    <span className="font-mono text-amber-400">{r.code}</span>{" "}
                    {r.ref ?? r.providerRecordId} — {r.message}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result.mode === "PREVIEW" && result.counts.wouldCreate > 0 && (
            <p className="mt-4 text-[11px] text-slate-500">
              Nothing has been written. {result.counts.wouldCreate} record(s) would be created if
              you commit.
            </p>
          )}

          {result.mode === "COMMIT" && result.counts.mailable === 0 && result.counts.created > 0 && (
            <div className="mt-4 bg-amber-950/20 border border-amber-800/40 rounded-xl p-3 flex items-start gap-2.5">
              <Sparkles className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-200/90 leading-relaxed">
                {result.counts.created} record(s) were created and none of them can be emailed
                yet. That is expected for indirectly collected data: send the Article 14 notice,
                record it on the tab above, and they become contactable.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
