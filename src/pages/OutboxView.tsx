import { apiFetch, readApiError } from '../lib/apiFetch';
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CheckCircle2,
  XCircle,
  ShieldCheck,
  Mail,
  RefreshCw,
  PauseCircle,
  PlayCircle,
  AlertTriangle,
  HelpCircle,
  RotateCcw,
} from 'lucide-react';
import {
  lockStateAt,
  lockDetailAt,
  lockDisplayFor,
  approvalEffectFor,
  approvalWarningFor,
  parseLockMap,
  type LockMap,
} from '../../shared/domain/autonomyDisplay';

/**
 * THE OPERATOR CONSOLE — and the three controls it did not reach.
 *
 * WHAT WAS WRONG
 * --------------
 * 1. THE PER-CONVERSATION STOP CONTROL HAD NO SURFACE. `actionGateway.checkHumanOwnershipLock`
 *    and `outbox.worker` both refuse to dispatch when a conversation is paused, and
 *    `POST /api/autonomy/:conversationId` can set that — but nothing in `src/` called it. Grep
 *    for `api/autonomy` across the frontend returned zero. An operator watching the system
 *    about to say the wrong thing to a customer could stop the whole tenant or nothing.
 *
 * 2. APPROVE DID NOT SAY WHAT IT WOULD DO. This console showed one green button per message
 *    regardless of the conversation's lock. Approving a message on a PAUSED conversation does
 *    not send it and does not hold it: the worker reads the lock immediately before dispatch
 *    and calls `markFailed(..., terminal = true)`, which writes DEAD_LETTER. The operator
 *    pressed Approve, the message went to a state requiring a second recovery decision, and
 *    nothing on this page had mentioned the lock.
 *
 * 3. DEAD_LETTER WAS INVISIBLE. `GET /api/outbox` returns HUMAN_REVIEW, PENDING and
 *    DEAD_LETTER; this page filtered to the first two. S38 built `POST /:id/requeue` as the way
 *    back from DEAD_LETTER, and the only way to reach it was curl. Messages that failed were
 *    simply absent from the console that exists to recover them.
 *
 * WHY THE DISPLAY LOGIC IS NOT IN THIS FILE
 * -----------------------------------------
 * `vitest.config.ts` is `environment: 'node'` and includes only `server/tests/**`, so nothing
 * here can be asserted on. The decisions — what an unknown lock displays as, what Approve will
 * actually cause — live in `shared/domain/autonomyDisplay.ts` as pure functions with their own
 * invariant suite. This component renders what they return. That split is the same one that
 * `autonomyLock.service.ts` records: logic a test cannot call is logic a mutation survives.
 *
 * §14 ON THIS SURFACE
 * -------------------
 * `locks` starts null and is null whenever the batch read fails. `lockStateAt` reads null, a
 * missing conversation, and an unrecognised state all as UNKNOWN, and UNKNOWN renders as a
 * refusal rather than as a blank or a green badge. The failure mode being avoided is the
 * console telling an operator autonomy is running at the exact moment it cannot tell.
 */

type ReviewStatus = 'HUMAN_REVIEW' | 'PENDING' | 'DEAD_LETTER';

interface OutboxRow {
  id: string;
  conversationId?: string;
  to?: string;
  subject?: string;
  textBody?: string;
  status?: string;
  lastError?: string;
  payload?: { to?: string; subject?: string; textBody?: string };
}

/** The queue, in the order an operator should work it: recoverable first, then held, then queued. */
const STATUS_ORDER: ReviewStatus[] = ['DEAD_LETTER', 'HUMAN_REVIEW', 'PENDING'];

const STATUS_STYLE: Record<ReviewStatus, string> = {
  DEAD_LETTER: 'bg-rose-100 text-rose-800',
  HUMAN_REVIEW: 'bg-amber-100 text-amber-800',
  PENDING: 'bg-blue-100 text-blue-800',
};

const TONE_STYLE = {
  running: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  paused: 'bg-amber-50 text-amber-900 border-amber-200',
  unknown: 'bg-slate-100 text-slate-700 border-slate-300',
} as const;

export const OutboxView: React.FC = () => {
  const [messages, setMessages] = useState<OutboxRow[]>([]);
  const [locks, setLocks] = useState<LockMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** The row whose reason box is open, and what it will do when submitted. */
  const [prompting, setPrompting] = useState<{
    id: string;
    kind: 'PAUSE' | 'RESUME' | 'REQUEUE' | 'REJECT';
  } | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const reviewable = useMemo(
    () =>
      messages
        .filter((m): m is OutboxRow & { status: ReviewStatus } =>
          (STATUS_ORDER as string[]).includes(m.status ?? '')
        )
        .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)),
    [messages]
  );

  /**
   * Load the queue, then the locks for the conversations it mentions.
   *
   * The lock read is a SECOND request rather than a field on the job, so that pausing a
   * conversation can refresh the badges without re-fetching every message body — and so that
   * a lock read failing leaves the queue itself on screen.
   */
  const loadLocks = useCallback(async (rows: OutboxRow[]) => {
    const ids = Array.from(
      new Set(rows.map((m) => m.conversationId).filter((id): id is string => !!id))
    );
    if (ids.length === 0) {
      setLocks({});
      return;
    }
    try {
      const res = await apiFetch(`/api/autonomy?conversationIds=${ids.map(encodeURIComponent).join(',')}`);
      if (!res.ok) {
        // Deliberately null, not the previous map: a stale badge saying "autonomy active" is
        // the one thing this page must never show when it cannot confirm it.
        setLocks(null);
        const body = await readApiError(res);
        setError(`Autonomy locks could not be read: ${body.message}`);
        return;
      }
      setLocks(parseLockMap(await res.json()));
    } catch (e) {
      setLocks(null);
      setError('Autonomy locks could not be read; every conversation shows as unreadable.');
    }
  }, []);

  const fetchOutbox = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/outbox');
      if (!res.ok) {
        const body = await readApiError(res);
        setError(body.message);
        return;
      }
      const data = await res.json();
      const rows: OutboxRow[] = Array.isArray(data) ? data : [];
      setMessages(rows);
      await loadLocks(rows);
    } catch (e) {
      setError('The outbox could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [loadLocks]);

  useEffect(() => {
    void fetchOutbox();
  }, [fetchOutbox]);

  const post = async (url: string, body?: unknown): Promise<boolean> => {
    setBusy(true);
    try {
      const res = await apiFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok) {
        const envelope = await readApiError(res);
        setError(envelope.message);
        return false;
      }
      return true;
    } catch (e) {
      setError('The request could not be completed.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleApprove = async (id: string) => {
    if (await post(`/api/outbox/${id}/approve`)) await fetchOutbox();
  };

  const submitPrompt = async (row: OutboxRow) => {
    if (!prompting || reason.trim().length === 0) return;
    const { kind } = prompting;
    let ok = false;
    if (kind === 'REJECT') {
      ok = await post(`/api/outbox/${row.id}/reject`, { reason: reason.trim() });
    } else if (kind === 'REQUEUE') {
      ok = await post(`/api/outbox/${row.id}/requeue`, { reason: reason.trim() });
    } else if (row.conversationId) {
      ok = await post(`/api/autonomy/${encodeURIComponent(row.conversationId)}`, {
        paused: kind === 'PAUSE',
        reason: reason.trim(),
      });
    }
    if (ok) {
      setPrompting(null);
      setReason('');
      await fetchOutbox();
    }
  };

  const openPrompt = (id: string, kind: 'PAUSE' | 'RESUME' | 'REQUEUE' | 'REJECT') => {
    setPrompting({ id, kind });
    setReason('');
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-900 tracking-tight">Transactional Outbox</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold border border-amber-200 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" />
              Human Review Mode
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Review and approve outbound mail, pause autonomy on a single conversation, and
            recover dead-lettered messages.
          </p>
        </div>
        <button
          onClick={() => void fetchOutbox()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-600 hover:text-slate-900 transition-colors shadow-2xs"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4">
        {reviewable.map((msg) => {
          const state = lockStateAt(locks, msg.conversationId);
          const display = lockDisplayFor(state);
          const detail = lockDetailAt(locks, msg.conversationId);
          const warning = approvalWarningFor(state);
          const open = prompting?.id === msg.id ? prompting : null;
          const to = msg.to ?? msg.payload?.to ?? '(no recipient recorded)';
          const subject = msg.subject ?? msg.payload?.subject ?? '(no subject)';
          const body = msg.textBody ?? msg.payload?.textBody ?? '';

          return (
            <div
              key={msg.id}
              className="p-5 rounded-2xl bg-white border border-slate-200 shadow-2xs space-y-3"
            >
              <div className="flex flex-col sm:flex-row gap-4 justify-between">
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mail className="w-4 h-4 text-slate-400" />
                    <span className="text-xs font-bold text-slate-900">{to}</span>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${STATUS_STYLE[msg.status]}`}
                    >
                      {msg.status}
                    </span>
                    <span
                      title={display.detail}
                      className={`text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 ${TONE_STYLE[display.tone]}`}
                    >
                      {display.tone === 'running' && <PlayCircle className="w-3 h-3" />}
                      {display.tone === 'paused' && <PauseCircle className="w-3 h-3" />}
                      {display.tone === 'unknown' && <HelpCircle className="w-3 h-3" />}
                      {display.label}
                    </span>
                  </div>
                  <h3 className="text-sm font-bold text-slate-900 break-words">{subject}</h3>
                  <div className="text-xs text-slate-600 font-mono whitespace-pre-wrap bg-slate-50 p-3 rounded-lg border border-slate-100 line-clamp-3 break-words">
                    {body}
                  </div>
                  {detail?.reason && (
                    <p className="text-[11px] text-slate-500">
                      {display.label}
                      {detail.actor ? ` by ${detail.actor}` : ''}
                      {detail.at ? ` at ${detail.at}` : ''}: {detail.reason}
                    </p>
                  )}
                  {msg.status === 'DEAD_LETTER' && msg.lastError && (
                    <p className="text-[11px] text-rose-700 break-words">
                      Last error: {msg.lastError}
                    </p>
                  )}
                </div>

                <div className="flex sm:flex-col items-stretch justify-end gap-2 pt-2 sm:pt-0 sm:w-48 shrink-0">
                  {msg.status === 'DEAD_LETTER' ? (
                    <button
                      disabled={busy}
                      onClick={() => openPrompt(msg.id, 'REQUEUE')}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 transition-colors w-full justify-center disabled:opacity-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Return to review
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => void handleApprove(msg.id)}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-white shadow-xs transition-colors w-full justify-center disabled:opacity-50 ${
                        approvalEffectFor(state) === 'SENDS'
                          ? 'bg-emerald-600 hover:bg-emerald-700'
                          : 'bg-slate-400 hover:bg-slate-500'
                      }`}
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      Approve
                    </button>
                  )}

                  {msg.status !== 'DEAD_LETTER' && (
                    <button
                      disabled={busy}
                      onClick={() => openPrompt(msg.id, 'REJECT')}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold text-rose-600 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition-colors w-full justify-center disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      Reject
                    </button>
                  )}

                  {/*
                    The stop control. Absent when the row carries no conversation id — there is
                    nothing to address the pause to, and a button that posts to `undefined`
                    would fail as a 404 that reads like a missing conversation.

                    Resume is offered only for a lock that was actually READ as paused;
                    `lockDisplayFor` returns `offerResume: false` for UNKNOWN, because a resume
                    writes an explicit `false` that outranks the legacy paused status, and
                    doing that against a state nobody could read is the one write here capable
                    of restarting a conversation somebody meant to stop.
                  */}
                  {msg.conversationId && (
                    <button
                      disabled={busy}
                      onClick={() => openPrompt(msg.id, display.offerResume ? 'RESUME' : 'PAUSE')}
                      className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-bold border transition-colors w-full justify-center disabled:opacity-50 ${
                        display.offerResume
                          ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border-emerald-200'
                          : 'text-amber-800 bg-amber-50 hover:bg-amber-100 border-amber-200'
                      }`}
                    >
                      {display.offerResume ? (
                        <PlayCircle className="w-4 h-4" />
                      ) : (
                        <PauseCircle className="w-4 h-4" />
                      )}
                      {display.offerResume ? 'Resume autonomy' : 'Pause autonomy'}
                    </button>
                  )}
                </div>
              </div>

              {warning && msg.status !== 'DEAD_LETTER' && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{warning}</span>
                </div>
              )}

              {open && (
                <div className="space-y-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <label className="text-[11px] font-bold text-slate-700 block">
                    {open.kind === 'PAUSE' && 'Why are you pausing this conversation?'}
                    {open.kind === 'RESUME' && 'Why is it safe to resume autonomy here?'}
                    {open.kind === 'REQUEUE' && 'Why are you returning this to review?'}
                    {open.kind === 'REJECT' && 'Why are you rejecting this message?'}
                  </label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    maxLength={500}
                    placeholder="Recorded against your identity in the operator action log."
                    className="w-full text-xs p-2 rounded-lg border border-slate-300 focus:outline-hidden focus:ring-2 focus:ring-slate-400"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      disabled={busy || reason.trim().length === 0}
                      onClick={() => void submitPrompt(msg)}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-slate-900 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => {
                        setPrompting(null);
                        setReason('');
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900"
                    >
                      Cancel
                    </button>
                    <span className="text-[10px] text-slate-500">
                      A reason is required in both directions — resuming most of all.
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {reviewable.length === 0 && !loading && (
          <div className="p-8 text-center bg-white rounded-2xl border border-slate-200 shadow-2xs">
            <ShieldCheck className="w-8 h-8 text-slate-300 mx-auto mb-3" />
            <h3 className="text-sm font-bold text-slate-900">Queue is Clear</h3>
            <p className="text-xs text-slate-500 mt-1">
              Nothing is awaiting review, queued for dispatch, or dead-lettered.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
