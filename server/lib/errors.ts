import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * P1.12 — ONE ERROR ENVELOPE (addendum §12, §11).
 *
 * WHAT WAS WRONG
 * --------------
 * Thirty-eight failure responses in server.ts, in at least four different shapes:
 *
 *     res.status(500).json({ error: e.message })          // 26 of them
 *     res.status(500).json({ error: "Failed to load..." })
 *     res.status(404).json({ error: "Not found" })
 *     res.status(401).json({ error: { code, message } })  // the newer ones
 *
 * Three consequences:
 *
 *   1. NO CLIENT CAN BRANCH ON THE FAILURE. `error` is sometimes a string and sometimes an
 *      object, so the only thing a caller can reliably do is check `res.ok`. That is exactly
 *      what the UI does — and it is why a 404 from the pipeline endpoint went unnoticed for
 *      the entire life of the feature.
 *
 *   2. INTERNAL DETAIL IS RETURNED TO THE CALLER. `e.message` is whatever Firestore, Postgres
 *      or the Gemini SDK produced: collection paths, constraint names, sometimes a fragment of
 *      a query. That is free reconnaissance, and on this deployment the paths it leaks are
 *      tenant paths.
 *
 *   3. NOTHING TIES A USER-VISIBLE FAILURE TO A LOG LINE. An operator reporting "it failed"
 *      has nothing to give anyone.
 *
 * THE ENVELOPE
 * ------------
 *     { error: { code, message, requestId, details? } }
 *
 * `code` is stable and machine-readable — the thing clients branch on. `message` is safe to
 * show a person. `requestId` appears in both the response and the server log, so a report can
 * be traced without asking the user to reproduce it. `details` is structured and optional, and
 * carries only what the caller needs in order to recover (the current version on a conflict,
 * the failing field on a validation error).
 *
 * The raw error goes to the log and NOT to the client.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

/**
 * Codes used across the API. Not exhaustive by design — a handler may define a more specific
 * one — but the common failures are named here so that clients and handlers agree.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  AUTH_UNAVAILABLE: 503,
  TENANT_UNRESOLVED: 403,
  TENANT_FORBIDDEN: 403,
  TENANT_SUSPENDED: 403,
  TENANT_REVOCATION_UNVERIFIABLE: 403,
  TENANT_AMBIGUOUS: 403,
  TENANT_INVALID: 403,
  /** A control said no: Safe Rebuild Mode, the kill switch, consent, suppression. */
  POLICY_BLOCKED: 403,
  /** An unauthenticated machine endpoint whose signature did not verify. */
  WEBHOOK_VERIFICATION_FAILED: 401,
  NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  ILLEGAL_TRANSITION: 422,
  TERMINAL_STATE: 422,
  UNKNOWN_TARGET_STATE: 422,
  UNKNOWN_CURRENT_STATE: 422,
  VERSION_REQUIRED: 428,
  PROVIDER_RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  STORE_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/**
 * An error that already knows how it should be reported.
 *
 * Handlers throw this instead of building a response, so the terminal handler is the only
 * place that formats a failure and there is no second shape to drift.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  /** Server-side only. Never sent to the client. */
  readonly cause?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = options.status ?? ErrorCodes[code] ?? 500;
    this.details = options.details;
    this.cause = options.cause;
  }
}

/**
 * Stamp every request with an id and echo it back.
 *
 * An inbound `X-Request-Id` is honoured so a trace survives a proxy — but it is bounded and
 * character-restricted first, because it ends up in log lines and an unbounded value is a log
 * injection primitive.
 */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const supplied = req.headers[REQUEST_ID_HEADER];
  const candidate = typeof supplied === 'string' ? supplied.trim() : '';
  const safe = /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : randomUUID();

  req.requestId = safe;
  res.setHeader(REQUEST_ID_HEADER, safe);
  next();
}

/**
 * Send a failure in the envelope. The single place a client-visible error is built.
 */
export function sendError(
  req: Request,
  res: Response,
  code: ErrorCode,
  message: string,
  options: { status?: number; details?: Record<string, unknown>; cause?: unknown } = {}
): Response {
  const status = options.status ?? ErrorCodes[code] ?? 500;

  if (options.cause) {
    // The detail lives here, correlated by requestId, and nowhere the caller can see.
    console.error(
      `[${req.requestId ?? 'no-request-id'}] ${code} on ${req.method} ${req.originalUrl}:`,
      options.cause
    );
  }

  if (res.headersSent) {
    console.error(`[${req.requestId}] Cannot send ${code}: response already sent.`);
    return res;
  }

  return res.status(status).json({
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(options.details ? { details: options.details } : {}),
    },
  });
}

/**
 * Wrap an async handler so a rejected promise reaches the terminal handler.
 *
 * Express 4 does not catch async rejections: an `await` that throws outside a try/catch becomes
 * an unhandled rejection and the request hangs until the client times out. Several handlers in
 * this file rely on their own try/catch for this, which works right up until someone adds an
 * `await` outside it.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * The terminal error handler. Mounted last; nothing gets past it.
 *
 * An unrecognised error becomes a generic 500 with the requestId. The original is logged. It
 * is never echoed, because "whatever the datastore said" is not a message for a customer.
 */
export function terminalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ApiError) {
    sendError(req, res, err.code, err.message, {
      status: err.status,
      details: err.details,
      cause: err.cause ?? err,
    });
    return;
  }

  console.error(
    `[${req.requestId ?? 'no-request-id'}] Unhandled error on ${req.method} ${req.originalUrl}:`,
    err
  );

  if (res.headersSent) return;

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed. Quote the requestId when reporting this.',
      requestId: req.requestId,
    },
  });
}

/**
 * Translate a caught exception into an envelope, for handlers that still use try/catch.
 *
 * This is the direct replacement for `res.status(500).json({ error: e.message })`: same shape
 * of call, but the caller gets a stable code and a request id while the raw message goes to
 * the log.
 */
export function sendCaught(req: Request, res: Response, err: unknown): Response {
  if (err instanceof ApiError) {
    return sendError(req, res, err.code, err.message, {
      status: err.status,
      details: err.details,
      cause: err.cause ?? err,
    });
  }
  return sendError(req, res, 'INTERNAL_ERROR', 'The request could not be completed.', {
    cause: err,
  });
}
