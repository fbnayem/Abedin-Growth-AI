import { store } from '../store';
import { orgPath, isValidOrgId } from '../tenancy/orgScope';
import { listServiceableOrgIds } from '../tenancy/organizations';
import { collection, doc, getDoc, getDocs, setDoc, query, where, updateDoc } from '../store';
import { circuitBreaker } from '../agents/salesDecisionEngine';

/**
 * P0.3 — Durable, shared, fail-closed kill switch.
 *
 * WHAT WAS WRONG
 * --------------
 * `POST /api/inbox/circuit-breaker/toggle` was `res.json({ success: true })`. It mutated
 * nothing, and returned no `circuitBreaker` field — while the admin console does
 * `setCircuitBreakerState(data.circuitBreaker)`, so the state became `undefined` and the next
 * render dereferenced it and threw. `GET /api/inbox/circuit-breaker` returned the real values
 * but under the keys `{enabled, reason}`, which the console also reads as `.circuitBreaker`,
 * so the panel broke on load too. Pressing stop during an incident either showed a false
 * paused state or white-screened the console.
 *
 * The previous "real" implementation only flipped a process-local boolean in
 * salesDecisionEngine. A second replica could not see it, and it did not survive a restart —
 * so it was not a kill switch, it was a local variable. It lived in
 * `controllers/killSwitch.controller.ts`, which had no callers and has now been DELETED: a
 * module that reads as the kill switch, mutates process memory and answers `success: true` is
 * the thing an operator finds when they go looking during an incident.
 *
 * THE DESIGN, AND WHY IT IS ASYMMETRIC
 * ------------------------------------
 * State is persisted so every replica observes the same decision. But the datastore is, until
 * P0.0 closes `firestore.rules`, world-writable — so persisting a plain "enabled" boolean
 * would hand an anonymous party the ability to switch autonomy ON.
 *
 * Authority is therefore split, and the two directions are NOT equally trusted:
 *
 *   PAUSING   may come from the durable store. Untrusted input can only ever move the system
 *             toward "stop", which is the safe direction.
 *   ENABLING  additionally requires AUTONOMY_ENABLED === 'true' in the environment, which is
 *             not writable through the application. A hostile write to the store cannot start
 *             sending; it can only stop it.
 *
 * Effective state = (environment permits autonomy) AND (no operator pause recorded).
 *
 * Every failure path resolves to PAUSED. If Firestore is unavailable, unreadable, or the
 * document is malformed, the system reports paused rather than assuming it may send — per
 * addendum §A, production action flags must fail closed.
 */

/**
 * P1.1 — The kill switch is GLOBAL, and now it is stored somewhere global.
 *
 * It used to live at organizations/<a hardcoded id>/settings/circuitBreaker, which read as a
 * per-tenant setting and behaved as a system-wide one. With real tenants that ambiguity stops
 * being cosmetic: an operator pausing "the organisation" would in fact have halted every
 * organisation, and an operator pausing a different one would have changed nothing.
 *
 * It is a system control, so it lives in a system collection, outside any tenant.
 */
const SYSTEM_SETTINGS_COLLECTION = 'system_settings';
const SETTINGS_DOC = 'circuitBreaker';

export interface CircuitBreakerView {
  globalAutonomousSendEnabled: boolean;
  pausedReason?: string;
  pausedBy?: string;
  pausedAt?: string;
  consecutiveErrorCount: number;
  duplicateSendAlertTriggered: boolean;
  bounceRateSpikeDetected: boolean;
  /** True when the environment does not permit autonomy at all, regardless of operator state. */
  autonomyDisabledByConfiguration: boolean;
  /** True when durable state could not be read and the system defaulted to paused. */
  degradedFailClosed: boolean;
}

interface DurableState {
  paused: boolean;
  reason?: string;
  actor?: string;
  at?: string;
}

/** Environment gate. Not writable through the application, so it is the only way to ENABLE. */
function environmentPermitsAutonomy(): boolean {
  return process.env.AUTONOMY_ENABLED === 'true';
}

function settingsRef() {
  if (!store) return null;
  return doc(store, SYSTEM_SETTINGS_COLLECTION, SETTINGS_DOC);
}

/**
 * Carry a pause forward from the pre-P1.1 location.
 *
 * Moving where a kill switch is stored has an obvious failure mode: an operator pause recorded
 * at the old location stops being read, and the system resumes sending without anyone deciding
 * that it should. That is precisely the silent-unpause this control exists to prevent, so the
 * old location is still consulted — and, consistent with the asymmetric-authority rule used
 * everywhere else here, it may only PAUSE. A legacy document saying "not paused" is ignored;
 * only a legacy pause is honoured.
 *
 * The old organisation id comes from LEGACY_KILL_SWITCH_ORG_ID rather than a literal. Unset
 * means there is nothing to migrate, which is the correct answer for a fresh deployment.
 */
async function legacyPauseStands(): Promise<{ paused: boolean; reason?: string }> {
  const legacyOrgId = process.env.LEGACY_KILL_SWITCH_ORG_ID;
  if (!store || !legacyOrgId || !isValidOrgId(legacyOrgId)) return { paused: false };
  try {
    const snap = await getDoc(doc(store, orgPath(legacyOrgId, 'settings'), SETTINGS_DOC));
    if (!snap.exists()) return { paused: false };
    const data: any = snap.data() || {};
    if (data.paused === true) {
      return {
        paused: true,
        reason:
          `Paused at the pre-P1.1 kill switch location (${legacyOrgId}): ` +
          `${data.reason || 'no reason given'}. Re-record the pause at the system location ` +
          `and clear LEGACY_KILL_SWITCH_ORG_ID to complete the migration.`,
      };
    }
    return { paused: false };
  } catch (e: any) {
    console.error('[CircuitBreaker] Could not read the legacy kill switch:', e?.message);
    // Unreadable legacy state is not evidence of a resume.
    return { paused: true, reason: 'Legacy kill switch state unreadable; failing closed.' };
  }
}

/**
 * Read durable pause state. Any failure returns "paused" — never "running".
 */
async function readDurableState(): Promise<{ state: DurableState; degraded: boolean }> {
  const ref = settingsRef();
  if (!ref) {
    return {
      state: { paused: true, reason: 'Durable store unavailable; failing closed.' },
      degraded: true,
    };
  }
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      // No operator decision recorded yet. Not an error, and not a pause: the environment
      // gate alone decides. A fresh install with AUTONOMY_ENABLED unset is already disabled.
      return { state: { paused: false }, degraded: false };
    }
    const data: any = snap.data() || {};
    if (typeof data.paused !== 'boolean') {
      return {
        state: { paused: true, reason: 'Malformed circuit breaker document; failing closed.' },
        degraded: true,
      };
    }
    return {
      state: { paused: data.paused, reason: data.reason, actor: data.actor, at: data.at },
      degraded: false,
    };
  } catch (e: any) {
    console.error('[CircuitBreaker] Could not read durable state; failing closed:', e?.message);
    return {
      state: { paused: true, reason: `Durable read failed: ${e?.message}` },
      degraded: true,
    };
  }
}

/**
 * The single source of truth for "may we perform an autonomous send right now".
 * Also mirrors the answer onto the legacy in-memory `circuitBreaker` object so existing
 * synchronous callers in salesDecisionEngine observe the same decision.
 */
export async function getCircuitBreakerState(): Promise<CircuitBreakerView> {
  const envPermits = environmentPermitsAutonomy();
  const { state: durable, degraded } = await readDurableState();

  // A pause recorded at the pre-P1.1 location still counts. It can only add a pause.
  const legacy = await legacyPauseStands();
  const state: DurableState = legacy.paused && !durable.paused
    ? { ...durable, paused: true, reason: legacy.reason }
    : durable;

  const enabled = envPermits && !state.paused && !degraded;

  // Keep the legacy in-process flag consistent with the durable decision, so code paths that
  // still read `circuitBreaker.globalAutonomousSendEnabled` synchronously cannot disagree
  // with this service. (Removing those reads entirely is tracked under P0.11.)
  circuitBreaker.globalAutonomousSendEnabled = enabled;
  circuitBreaker.pausedReason = enabled ? undefined : buildReason(envPermits, state, degraded);

  return {
    globalAutonomousSendEnabled: enabled,
    pausedReason: enabled ? undefined : buildReason(envPermits, state, degraded),
    pausedBy: state.actor,
    pausedAt: state.at,
    consecutiveErrorCount: circuitBreaker.consecutiveErrorCount || 0,
    duplicateSendAlertTriggered: !!circuitBreaker.duplicateSendAlertTriggered,
    bounceRateSpikeDetected: !!circuitBreaker.bounceRateSpikeDetected,
    autonomyDisabledByConfiguration: !envPermits,
    degradedFailClosed: degraded,
  };
}

function buildReason(envPermits: boolean, state: DurableState, degraded: boolean): string {
  if (degraded) return state.reason || 'Durable state unreadable; failing closed.';

  // Both constraints can apply at once. Report every reason that is currently holding the
  // system down, not just the first one — during an incident an operator needs to know that
  // clearing their own pause will not resume sending, and equally that enabling the
  // configuration will not resume it while an operator pause stands.
  const reasons: string[] = [];
  if (!envPermits) {
    reasons.push(
      'Autonomy is disabled by configuration (AUTONOMY_ENABLED is not "true"). ' +
        'This cannot be overridden from the application.'
    );
  }
  if (state.paused) {
    reasons.push(
      `Paused by operator${state.actor ? ` (${state.actor})` : ''}: ` +
        `${state.reason || 'no reason given'}.`
    );
  }
  if (reasons.length === 0) return 'Paused.';
  return reasons.join(' ALSO: ');
}

/**
 * Operator action. Pausing always succeeds. Resuming succeeds only if the environment permits
 * autonomy — otherwise the caller is told plainly that the switch cannot start sending.
 */
export async function setCircuitBreaker(
  enabled: boolean,
  reason: string | undefined,
  actor: string
): Promise<{ state: CircuitBreakerView; accepted: boolean; message?: string }> {
  const ref = settingsRef();

  if (!ref) {
    // Cannot persist. Refuse to claim success — a kill switch that silently fails to record
    // its decision is the failure mode this item exists to remove.
    const state = await getCircuitBreakerState();
    return {
      state,
      accepted: false,
      message: 'Durable store unavailable; the request was not recorded. System remains paused.',
    };
  }

  // Firestore's setDoc rejects `undefined` field values outright, so the document is built
  // with only the fields that actually have values. Writing `reason: undefined` on the resume
  // path threw and — correctly — failed closed, but a kill switch that cannot record "resume"
  // is still broken. Found by runtime testing; it type-checked and built cleanly.
  const record: DurableState = {
    paused: !enabled,
    actor,
    // Timestamp is generated here rather than trusted from the client.
    at: new Date().toISOString(),
  };
  if (!enabled) {
    record.reason = reason || 'MANUAL_KILL_SWITCH_ENGAGED';
  }

  try {
    await setDoc(ref, record, { merge: false });
  } catch (e: any) {
    console.error('[CircuitBreaker] Failed to persist state:', e?.message);
    const state = await getCircuitBreakerState();
    return {
      state,
      accepted: false,
      message: `Failed to persist kill switch state: ${e?.message}. System remains paused.`,
    };
  }

  if (!enabled) {
    console.warn(`[KILL SWITCH] Global outbound halted by ${actor}. Reason: ${record.reason}`);
    await cancelPendingOutbox(actor, record.reason || 'Kill switch engaged');
  } else {
    console.log(`[KILL SWITCH] Resume requested by ${actor}.`);
  }

  const state = await getCircuitBreakerState();

  // Resuming while the environment forbids autonomy is not an error, but the operator must not
  // be left believing sending is live when it is not.
  if (enabled && !state.globalAutonomousSendEnabled) {
    return {
      state,
      accepted: true,
      message:
        'Operator pause cleared, but autonomous sending remains disabled because ' +
        'AUTONOMY_ENABLED is not "true" in this environment.',
    };
  }

  return { state, accepted: true };
}

/**
 * Cancel queued work so that engaging the switch stops what is already in flight, not merely
 * what has yet to be enqueued. Best-effort and non-throwing: a failure here must never prevent
 * the pause itself from being recorded.
 */
async function cancelPendingOutbox(actor: string, reason: string): Promise<number> {
  if (!store) return 0;

  // P1.1 — A global stop must stop every tenant. Cancelling only one organisation's queue
  // would have left the switch looking engaged while other tenants' mail continued.
  const orgIds = await listServiceableOrgIds();
  if (orgIds.length === 0) {
    console.warn(
      '[KILL SWITCH] No serviceable organisations resolved, so no queued jobs were cancelled. ' +
        'The pause itself still stands: the worker resolves the same empty list and dispatches nothing.'
    );
    return 0;
  }

  let cancelled = 0;
  for (const orgId of orgIds) {
    try {
      const outboxRef = collection(store, orgPath(orgId, 'outbox'));
      const pending = await getDocs(query(outboxRef, where('status', '==', 'PENDING')));
      for (const d of pending.docs) {
        try {
          await updateDoc(d.ref, {
            status: 'CANCELLED',
            cancelledBy: actor,
            cancelledReason: reason,
            cancelledAt: new Date().toISOString(),
          });
          cancelled++;
        } catch (inner: any) {
          console.error(`[CircuitBreaker] Could not cancel outbox job ${d.id}:`, inner?.message);
        }
      }
    } catch (e: any) {
      // One tenant failing must not stop the others being cancelled.
      console.error(`[CircuitBreaker] Could not cancel pending jobs for ${orgId}:`, e?.message);
    }
  }

  if (cancelled > 0) {
    console.warn(`[KILL SWITCH] Cancelled ${cancelled} pending outbox job(s) across ${orgIds.length} organisation(s).`);
  }
  return cancelled;
}
