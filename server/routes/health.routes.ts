import { Router, type Request, type Response } from 'express';
import { safeModeSnapshot, isFullySafeMode } from '../config/safeMode';
import { store } from '../store';
import { schemaCompatibility } from '../build/schemaCompatibility';
import { healthResponse } from '../build/health';
import { resolveProvenance } from '../build/provenance';

/**
 * S39 — Health and readiness.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const healthRouter = Router();

// EXECUTABLE READINESS CHECK (Requirement X)
healthRouter.get('/readiness', async (req: Request, res: Response) => {
  try {
    // P0.2 — These flags are now read through server/config/safeMode.ts, the SAME module
    // the ActionGateway consults when it decides whether to dispatch. Previously this
    // handler read process.env directly at request time while the gateway used a snapshot
    // taken at module-evaluation time, before dotenv had run — so this endpoint could
    // report "real sending is ON" while the gateway enforced OFF, or the reverse. The
    // operator-facing indicator and the enforcement point are now the same read.
    const flags = safeModeSnapshot();
    const checks = {
      databaseConnectivity: !!store,
      actionGatewayLoaded: true, // We import it statically
      safeRebuildMode: {
        email: flags.REAL_EMAIL_SEND_ENABLED,
        calendar: flags.REAL_CALENDAR_CREATE_ENABLED,
        payment: flags.REAL_PAYMENT_ENABLED,
        signature: flags.REAL_SIGNATURE_ENABLED,
        linkedIn: flags.REAL_LINKEDIN_SEND_ENABLED,
        // P2c/P2d — neither sends anything to a prospect, and both are real actions: one
        // spends this tenant's money at a third party, the other makes requests to somebody
        // else's servers under this system's name. `allExternalActionsDisabled` already
        // covered them through `isFullySafeMode()`; they are listed here so the aggregate and
        // the per-flag view cannot disagree about what it aggregates.
        discovery: flags.REAL_DISCOVERY_ENABLED,
        scrape: flags.REAL_SCRAPE_ENABLED,
        allExternalActionsDisabled: isFullySafeMode(),
      },
      // NOTE (S47, tracked in the P3 roadmap): the checks above still test object existence
      // rather than capability. `databaseConnectivity` is a truthiness test on the Firestore
      // handle, not an executed query, and Postgres is not probed at all — so this endpoint
      // can report READY while a required production dependency cannot perform its function.
      // Do not treat READY as proof of capability until that work lands.
      verifiesCapability: false,
    };

    const isReady = checks.databaseConnectivity;

    res.json({
      status: isReady ? "READY" : "NOT_READY",
      checks
    });
  } catch (e: any) {
    res.status(500).json({ status: "DEGRADED", error: e.message });
  }
});

healthRouter.get('/health', async (req: Request, res: Response) => {
  // S49 — this used to answer `{ status: "ok", service: "..." }`, which is the same string in
  // every build that has ever run. S49's worst case turns on that: an operator reaching for
  // the kill switch cannot say which build is live or what to roll back to, and the service
  // name does not help them. `source` is reported beside the SHA because an injected SHA
  // identifies a released artifact and one read from a working tree does not — treating them
  // the same is how a wrong answer becomes worse than no answer.
  // S48 — the verdict now depends on the fact reported beside it.
  //
  // This reported `expectsMigration` and then answered "ok" whether or not that migration had
  // been applied. A health endpoint that prints the evidence and ignores it is worse than one
  // that prints neither: it looks like the check was made.
  const answer = healthResponse(resolveProvenance(), await schemaCompatibility());
  res.status(answer.status).json(answer.body);
});
