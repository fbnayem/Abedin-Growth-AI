/**
 * THE PORT THIS PROCESS LISTENS ON.
 *
 * WHAT WAS WRONG
 * --------------
 * `server.ts` had `const PORT = 3000;` while `.env.example` documented `PORT=3000` as though it
 * were read. It was not. Found during the 2026-09-10 audit by starting the server with
 * `PORT=8791` and watching it bind 3000 anyway.
 *
 * Cloud Run, App Engine and most container platforms tell a process where traffic will arrive by
 * setting `PORT`, and send requests and health checks there. A process that binds a different
 * port deploys cleanly, is never reached, and is restarted as unhealthy — with nothing in its own
 * log to say why, because from inside the container it is listening perfectly well.
 *
 * WHY THIS ONE HAS A DEFAULT
 * --------------------------
 * Most configuration in this codebase refuses rather than defaulting, so the exception is worth
 * stating. §14 forbids unknown state becoming PERMISSION. An absent `PORT` grants nothing; 3000
 * is the documented local value, and a developer running `npm run dev` should not need to set it.
 *
 * A PRESENT but malformed `PORT` is a different fact: it is an operator's instruction this
 * process cannot follow. Binding somewhere else instead is how a deploy comes up looking healthy
 * on a port nobody routes to. That refuses, at startup, before anything binds.
 */

export const DEFAULT_PORT = 3000;

export type PortResolution =
  | { readonly ok: true; readonly port: number; readonly source: 'ENV' | 'DEFAULT' }
  | { readonly ok: false; readonly reason: string };

/**
 * The port, or the reason `PORT` cannot be used.
 *
 * Read at CALL time, for the reason S46 records: ES module imports are hoisted above
 * `dotenv.config()`, so a module-level snapshot would read the environment from before `.env`
 * was loaded.
 */
export function portFrom(env: NodeJS.ProcessEnv = process.env): PortResolution {
  const raw = env.PORT;
  // Blank is absent: `PORT=` is what a copied `.env.example` line with its value removed
  // produces, and dotenv sets it to the empty string rather than leaving it unset.
  if (raw === undefined || raw.trim().length === 0) {
    return { ok: true, port: DEFAULT_PORT, source: 'DEFAULT' };
  }

  const trimmed = raw.trim();
  // Digits only, and not `parseInt` or `Number`: `parseInt('8080abc')` is 8080 and
  // `Number('0x50')` is 80. Each is a reading in which the process binds a port nobody wrote.
  if (!/^\d{1,5}$/.test(trimmed)) {
    return {
      ok: false,
      reason:
        `PORT must be an integer from 1 to 65535; received ${JSON.stringify(raw)}. Refusing ` +
        'to bind a port the platform is not routing to.',
    };
  }

  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    return {
      ok: false,
      reason: `PORT must be from 1 to 65535; received ${JSON.stringify(raw)}.`,
    };
  }

  return { ok: true, port, source: 'ENV' };
}

/** For `server.ts`: the port, or a thrown error that stops startup before anything binds. */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const resolved = portFrom(env);
  if (resolved.ok === false) {
    throw new Error(`[config] ${resolved.reason}`);
  }
  return resolved.port;
}
