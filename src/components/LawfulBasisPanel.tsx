import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, MailCheck, ShieldCheck, ShieldOff } from "lucide-react";
import { apiFetch, readApiError } from "../lib/apiFetch";

/**
 * WHETHER THIS PERSON MAY BE EMAILED, AND WHY NOT.
 *
 * Every other surface in this console shows a lead as a row with a score. None of them has ever
 * shown the one fact that decides whether anything can be sent — and for the whole life of the
 * system the answer was no, for every lead, with no way to see that or change it.
 *
 * THE PANEL IS DESIGNED AROUND THE REFUSAL
 * ----------------------------------------
 * The green case needs one line. The useful case is the refusal, which names the condition that
 * is unmet and offers the specific action that would meet it. "LI_NOTICE_NOT_SENT" as a code is
 * useless to an operator; "the person has not been told where their data came from, and here is
 * the button that records that you have told them" is not.
 *
 * WHAT THE PANEL WILL NOT DO
 * --------------------------
 * There is no field for the consent flag, and there never will be: consent is a record of
 * something that happened in the world, and a checkbox in an admin screen is not evidence of
 * it. What can be recorded is the BASIS and the evidence for it, attributed to the person
 * recording it. Nor can the notice be backdated — the timestamp is the moment of the click,
 * because a date nothing can check is not evidence either.
 */

interface Contact {
  id: string;
  email?: string;
  lawfulBasis?: string | null;
  consentGiven?: boolean;
  consentEvidence?: string | null;
  consentSource?: string | null;
  consentRecordedAt?: string | null;
  consentRecordedBy?: string | null;
  consentRevokedAt?: string | null;
  liaId?: string | null;
  article14NoticeSentAt?: string | null;
  addressType?: string | null;
  country?: string | null;
  source?: string | null;
  sourceEvidence?: string | null;
  sourceCollectedAt?: string | null;
  importBatchId?: string | null;
  suppressed?: boolean;
  unsubscribed?: boolean;
}

interface BasisResponse {
  contactId: string;
  basis?: string;
  mailable: boolean;
  reason: string;
  refusalCode?: string | null;
}

const label = "block text-[11px] font-semibold text-slate-500 uppercase tracking-wider mb-1";
const input =
  "w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-500";

/** What an operator should do next, per refusal code. The code alone is not actionable. */
const NEXT_STEP: Record<string, string> = {
  NO_BASIS: "Record a lawful basis below.",
  UNKNOWN_BASIS: "The stored basis is not one this system recognises. Record it again.",
  COUNTRY_UNKNOWN: "Set the contact's country to an ISO-3166 alpha-2 code such as GB.",
  COUNTRY_NOT_REVIEWED:
    "This country's outreach rules have not been reviewed and added to the table. That is an owner decision, not something to work around here.",
  CONSENT_NOT_RECORDED: "Record consent, with evidence of where and when it was given.",
  CONSENT_REVOKED:
    "This person withdrew consent. They can be re-subscribed only on fresh evidence that they opted in again.",
  CONSENT_UNEVIDENCED: "Add evidence of where and when consent was given.",
  CONSENT_UNATTRIBUTED: "Record the basis again while signed in, so the record names who recorded it.",
  LI_NOT_AVAILABLE_IN_COUNTRY:
    "This country requires prior consent, including business to business. Legitimate interest is not available here.",
  LI_ADDRESS_TYPE_UNKNOWN: "Say whether this is a named person's address or a role address such as info@.",
  LI_INDIVIDUAL_SUBSCRIBER:
    "This is a free-mail address, which makes the recipient an individual subscriber rather than a business one. Legitimate interest does not reach that case; consent does.",
  LI_NO_ASSESSMENT: "Reference the balancing assessment that covers this contact.",
  LI_NOTICE_NOT_SENT:
    "The person has not been told where their data came from. Send that notice, then record it below.",
};

export const LawfulBasisPanel: React.FC<{ contact: Contact; onChanged?: () => void }> = ({
  contact,
  onChanged,
}) => {
  const [verdict, setVerdict] = useState<BasisResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const [basis, setBasis] = useState(contact.lawfulBasis ?? "LEGITIMATE_INTEREST");
  const [country, setCountry] = useState(contact.country ?? "");
  const [addressType, setAddressType] = useState(contact.addressType ?? "");
  const [consentEvidence, setConsentEvidence] = useState(contact.consentEvidence ?? "");
  const [consentSource, setConsentSource] = useState(contact.consentSource ?? "");
  const [liaId, setLiaId] = useState(contact.liaId ?? "");
  const [acknowledge, setAcknowledge] = useState(false);

  useEffect(() => {
    setBasis(contact.lawfulBasis ?? "LEGITIMATE_INTEREST");
    setCountry(contact.country ?? "");
    setAddressType(contact.addressType ?? "");
    setConsentEvidence(contact.consentEvidence ?? "");
    setConsentSource(contact.consentSource ?? "");
    setLiaId(contact.liaId ?? "");
    setVerdict(null);
    setError(null);
  }, [contact.id]);

  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError((await readApiError(res)).message);
        return;
      }
      setVerdict((await res.json()) as BasisResponse);
      setEditing(false);
      onChanged?.();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const record = () =>
    post(`/api/contacts/${encodeURIComponent(contact.id)}/lawful-basis`, {
      basis,
      country: country.trim() === "" ? undefined : country.trim().toUpperCase(),
      addressType: addressType === "" ? undefined : addressType,
      consentEvidence: consentEvidence.trim() === "" ? undefined : consentEvidence.trim(),
      consentSource: consentSource.trim() === "" ? undefined : consentSource.trim(),
      liaId: liaId.trim() === "" ? undefined : liaId.trim(),
      acknowledgesRevocation: acknowledge ? true : undefined,
    });

  const revoke = () =>
    post(`/api/contacts/${encodeURIComponent(contact.id)}/revoke-consent`, {
      reason: "Withdrawn through the console.",
    });

  const recordNotice = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/leads/notice-sent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactIds: [contact.id],
          evidence: `Article 14 notice sent to ${contact.email ?? contact.id} and recorded from the lead detail.`,
        }),
      });
      if (!res.ok) {
        setError((await readApiError(res)).message);
        return;
      }
      const body = (await res.json()) as { outcomes: { reason: string; mailable: boolean }[] };
      const first = body.outcomes[0];
      setVerdict({
        contactId: contact.id,
        mailable: first?.mailable ?? false,
        reason: first?.reason ?? "Recorded.",
      });
      onChanged?.();
    } finally {
      setBusy(false);
    }
  };

  const suppressed = contact.suppressed === true || contact.unsubscribed === true;
  const mailable = verdict?.mailable ?? false;
  const refusalCode = verdict?.refusalCode ?? null;

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {suppressed ? (
            <ShieldOff className="w-4 h-4 text-rose-600" />
          ) : mailable ? (
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
          ) : (
            <ShieldCheck className="w-4 h-4 text-slate-400" />
          )}
          <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
            Lawful basis for contacting this person
          </h3>
        </div>
        {!editing && !suppressed && (
          <button
            onClick={() => setEditing(true)}
            className="text-[11px] font-semibold text-blue-700 hover:text-blue-900"
          >
            Record a basis
          </button>
        )}
      </div>

      <div className="p-4 space-y-3">
        {suppressed && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 flex items-start gap-2.5">
            <ShieldOff className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-rose-900 leading-relaxed">
              This person has unsubscribed or been suppressed. That outranks any lawful basis:
              the later statement is the operative one, and nothing can be sent to them. Recording
              a basis does not change it, and is not a way to walk it back.
            </p>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
          <div>
            <dt className={label}>Basis on file</dt>
            <dd className="text-xs text-slate-800">{contact.lawfulBasis ?? "None recorded"}</dd>
          </div>
          <div>
            <dt className={label}>Country</dt>
            <dd className="text-xs text-slate-800">{contact.country ?? "Not stated"}</dd>
          </div>
          <div>
            <dt className={label}>Address type</dt>
            <dd className="text-xs text-slate-800">{contact.addressType ?? "Not stated"}</dd>
          </div>
          <div>
            <dt className={label}>Article 14 notice</dt>
            <dd className="text-xs text-slate-800">
              {contact.article14NoticeSentAt ?? "Not sent"}
            </dd>
          </div>
          {contact.lawfulBasis === "CONSENT" && (
            <>
              <div className="col-span-2">
                <dt className={label}>Consent evidence</dt>
                <dd className="text-xs text-slate-800 break-words">
                  {contact.consentEvidence ?? "None"}
                </dd>
              </div>
              <div>
                <dt className={label}>Recorded by</dt>
                <dd className="text-xs text-slate-800">{contact.consentRecordedBy ?? "—"}</dd>
              </div>
              <div>
                <dt className={label}>Recorded at</dt>
                <dd className="text-xs text-slate-800">{contact.consentRecordedAt ?? "—"}</dd>
              </div>
            </>
          )}
          {contact.consentRevokedAt && (
            <div className="col-span-2">
              <dt className={label}>Consent revoked</dt>
              <dd className="text-xs text-rose-700">{contact.consentRevokedAt}</dd>
            </div>
          )}
          {contact.liaId && (
            <div className="col-span-2">
              <dt className={label}>Balancing assessment</dt>
              <dd className="text-xs text-slate-800">{contact.liaId}</dd>
            </div>
          )}
        </dl>

        {/* Provenance — where this record came from, which the notice has to state. */}
        <div className="pt-3 border-t border-slate-100">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
            <div>
              <dt className={label}>Source</dt>
              <dd className="text-xs text-slate-800">{contact.source ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt className={label}>Collected</dt>
              <dd className="text-xs text-slate-800">{contact.sourceCollectedAt ?? "—"}</dd>
            </div>
            <div className="col-span-2">
              <dt className={label}>Where it came from</dt>
              <dd className="text-xs text-slate-600 break-words leading-relaxed">
                {contact.sourceEvidence ?? "Not recorded. A record whose origin is unknown cannot be given an Article 14 notice."}
              </dd>
            </div>
          </dl>
        </div>

        {verdict !== null && (
          <div
            className={`rounded-lg p-3 flex items-start gap-2.5 ${
              verdict.mailable
                ? "bg-emerald-50 border border-emerald-200"
                : "bg-amber-50 border border-amber-200"
            }`}
          >
            {verdict.mailable ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            )}
            <div>
              <p className={`text-xs leading-relaxed ${verdict.mailable ? "text-emerald-900" : "text-amber-900"}`}>
                {verdict.reason}
              </p>
              {refusalCode !== null && NEXT_STEP[refusalCode] !== undefined && (
                <p className="text-xs text-amber-800 mt-1.5 font-medium">{NEXT_STEP[refusalCode]}</p>
              )}
            </div>
          </div>
        )}

        {error !== null && (
          <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-xs text-rose-900 leading-relaxed">
            {error}
          </div>
        )}

        {editing && (
          <div className="pt-3 border-t border-slate-100 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={label}>Basis</label>
                <select value={basis} onChange={(e) => setBasis(e.target.value)} className={input}>
                  <option value="LEGITIMATE_INTEREST">Legitimate interest (B2B)</option>
                  <option value="CONSENT">Consent</option>
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
              <div>
                <label className={label}>Address type</label>
                <select value={addressType} onChange={(e) => setAddressType(e.target.value)} className={input}>
                  <option value="">Not stated</option>
                  <option value="ROLE">Role address (info@)</option>
                  <option value="PERSONAL">A named person</option>
                </select>
              </div>
              {basis === "LEGITIMATE_INTEREST" ? (
                <div>
                  <label className={label}>Balancing assessment id</label>
                  <input value={liaId} onChange={(e) => setLiaId(e.target.value)} className={input} />
                </div>
              ) : (
                <div>
                  <label className={label}>Consent source</label>
                  <input value={consentSource} onChange={(e) => setConsentSource(e.target.value)} className={input} placeholder="pricing-page" />
                </div>
              )}
            </div>

            {basis === "CONSENT" && (
              <div>
                <label className={label}>Consent evidence — where and when, checkably</label>
                <input
                  value={consentEvidence}
                  onChange={(e) => setConsentEvidence(e.target.value)}
                  className={input}
                  placeholder="webform:pricing-page 2026-09-01T10:00:00Z ip=203.0.113.7"
                />
              </div>
            )}

            {basis === "CONSENT" && contact.consentRevokedAt && (
              <label className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
                <input
                  type="checkbox"
                  checked={acknowledge}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="leading-relaxed">
                  This person previously withdrew consent. I am recording it again on fresh
                  evidence that they have opted in since.
                </span>
              </label>
            )}

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Your name is recorded against this. There is no field for the consent flag itself:
              it is derived from the basis, so the two can never disagree.
            </p>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void record()}
                disabled={busy}
                className="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                Record
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-3.5 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 rounded-lg"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-2">
          <button
            onClick={() => void recordNotice()}
            disabled={busy || contact.article14NoticeSentAt != null}
            className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold rounded-lg disabled:opacity-40 flex items-center gap-1.5"
            title={
              contact.article14NoticeSentAt != null
                ? "Already recorded; the original date stands."
                : "Records that you have sent it. The timestamp is now."
            }
          >
            <MailCheck className="w-3.5 h-3.5" />
            I have sent the Article 14 notice
          </button>
          {contact.consentGiven === true && (
            <button
              onClick={() => void revoke()}
              disabled={busy}
              className="px-3 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11px] font-semibold rounded-lg disabled:opacity-40 flex items-center gap-1.5"
            >
              <ShieldOff className="w-3.5 h-3.5" />
              Withdraw consent
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
