import dotenv from 'dotenv';

/**
 * P0.2 — Single source of truth for the Safe Rebuild Mode production-action flags.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The ActionGateway used to snapshot these flags into a `private readonly SAFE_MODE = {...}`
 * class field. That field is evaluated when the module is evaluated, and `server.ts` reaches
 * the gateway through `import { outboxWorker } from "./server/workers/outbox.worker"` on line
 * 6 — while `dotenv.config()` sat at line 52. ES module imports are hoisted and their bodies
 * run before the importing module's own statements, so dotenv had NOT run yet and values in
 * `.env` never reached the enforcement point; only real OS/platform environment variables did.
 *
 * Meanwhile `/api/readiness` read `process.env.REAL_EMAIL_SEND_ENABLED` at REQUEST time, long
 * after dotenv had run. The result: the flag the operator reads and the flag the system
 * enforces were different values, read from different places at different times, and could
 * disagree in both directions. An operator could see "real sending is ON" while the gateway
 * enforced OFF, or the reverse.
 *
 * THE FIX
 * -------
 * 1. dotenv.config() is called HERE, at the top of this module. Because the gateway imports
 *    this module, dotenv is guaranteed to have run before any flag is read, regardless of
 *    where this module sits in anyone's import list.
 * 2. Flags are read LAZILY, per call, rather than snapshotted. Even if some future entrypoint
 *    manages to evaluate modules in a surprising order, there is no stale copy to diverge.
 * 3. Both the gateway and /api/readiness call into this module, so the displayed value and the
 *    enforced value are by construction the same value.
 *
 * FAIL-CLOSED SEMANTICS
 * ---------------------
 * A flag is enabled ONLY when its variable is exactly the string "true". Absent, empty,
 * malformed, "TRUE", "1" and "yes" all evaluate to DISABLED. Per addendum §A, production
 * action flags must fail closed, so ambiguity resolves to "do not perform the real action".
 */

dotenv.config();

export type RealActionFlag =
  | 'REAL_EMAIL_SEND_ENABLED'
  | 'REAL_CALENDAR_CREATE_ENABLED'
  | 'REAL_PAYMENT_ENABLED'
  | 'REAL_SIGNATURE_ENABLED'
  | 'REAL_LINKEDIN_SEND_ENABLED'
  | 'REAL_DISCOVERY_ENABLED'
  | 'REAL_SCRAPE_ENABLED';

/**
 * DISCOVERY AND SCRAPING ARE REAL ACTIONS, and they are in this list rather than in a list of
 * their own for a reason worth stating.
 *
 * Neither sends anything to a prospect, so it is tempting to treat them as reads. They are not.
 * A discovery lookup spends money on a third-party API against a tenant's budget. A scrape
 * makes requests to somebody else's servers from this system's address, under this system's
 * user agent, and the consequence of getting it wrong is a blocked IP or a breached term of
 * service — an effect in the world that cannot be undone by deleting a row.
 *
 * Being in REAL_ACTION_FLAGS means `isFullySafeMode()` is false while either is on, and that
 * `/api/readiness` reports them. An operator asking "can this system touch anything outside
 * itself?" gets one answer covering all seven.
 */
export const REAL_ACTION_FLAGS: RealActionFlag[] = [
  'REAL_EMAIL_SEND_ENABLED',
  'REAL_CALENDAR_CREATE_ENABLED',
  'REAL_PAYMENT_ENABLED',
  'REAL_SIGNATURE_ENABLED',
  'REAL_LINKEDIN_SEND_ENABLED',
  'REAL_DISCOVERY_ENABLED',
  'REAL_SCRAPE_ENABLED',
];

/**
 * Read one production-action flag. Fails closed: anything other than the exact string
 * "true" disables the real action.
 */
export function isRealActionEnabled(flag: RealActionFlag): boolean {
  return process.env[flag] === 'true';
}

/**
 * S23/P0.2 — whether the reply composer may call a model at all.
 *
 * This was read as a bare `process.env.USE_GENAI_FOR_REPLIES === 'true'` inside
 * `composeAutonomousSalesReply` — a direct environment read at decision time, which is the
 * shape this module exists to eliminate. It is here so there is one reader, it fails closed
 * like the rest, and an operator surface can report it.
 *
 * Disabled does NOT mean "compose it some other way". It means the composer abstains: see
 * server/domain/abstention.ts for why the alternative was worse than nothing.
 */
export function isGenerationEnabled(): boolean {
  return process.env.USE_GENAI_FOR_REPLIES === 'true';
}

/**
 * The full flag set, for /api/readiness and operator surfaces. This is the SAME read the
 * gateway performs, so what an operator sees is what the system will enforce.
 */
export function safeModeSnapshot(): Record<RealActionFlag, boolean> {
  return {
    REAL_EMAIL_SEND_ENABLED: isRealActionEnabled('REAL_EMAIL_SEND_ENABLED'),
    REAL_CALENDAR_CREATE_ENABLED: isRealActionEnabled('REAL_CALENDAR_CREATE_ENABLED'),
    REAL_PAYMENT_ENABLED: isRealActionEnabled('REAL_PAYMENT_ENABLED'),
    REAL_SIGNATURE_ENABLED: isRealActionEnabled('REAL_SIGNATURE_ENABLED'),
    REAL_LINKEDIN_SEND_ENABLED: isRealActionEnabled('REAL_LINKEDIN_SEND_ENABLED'),
    REAL_DISCOVERY_ENABLED: isRealActionEnabled('REAL_DISCOVERY_ENABLED'),
    REAL_SCRAPE_ENABLED: isRealActionEnabled('REAL_SCRAPE_ENABLED'),
  };
}

/**
 * True when every real-action flag is disabled, i.e. the system cannot perform any external
 * side effect. Readiness reports this so "safe" is a single unambiguous claim rather than
 * something the reader has to assemble from five separate booleans.
 */
export function isFullySafeMode(): boolean {
  return REAL_ACTION_FLAGS.every((f) => !isRealActionEnabled(f));
}
