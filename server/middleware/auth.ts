import { Request, Response, NextFunction } from 'express';
import { firebaseAuth } from '../firebase';

declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

/**
 * P0.4 — Authentication that fails closed.
 *
 * WHAT WAS WRONG
 * --------------
 * This middleware had three separate ways to admit an unauthenticated caller:
 *
 *   1. No `Authorization` header at all      -> req.user = { uid: "preview_uid" }, next()
 *   2. The literal bearer token "demo_bary"  -> a named user session, minted from a constant
 *   3. `firebaseAuth` failed to initialise   -> EVERY token accepted without verification
 *
 * (3) is the worst: Firebase initialisation is wrapped in a try/catch that only logs, so a
 * misconfigured deployment degrades silently from "verifies tokens" to "accepts anything",
 * with no signal other than a console line at boot. Tenancy, rate limiting, audit attribution
 * and operator accountability are all keyed on identity, so an unauthenticated caller
 * undermines every one of them at once.
 *
 * THE FIX
 * -------
 * Verification is now the only path to a session. There is exactly one escape hatch, and it
 * is deliberately awkward: ALLOW_ANONYMOUS_DEV_AUTH must be exactly "true" AND NODE_ENV must
 * not be "production". Both conditions are checked per request, so the hatch cannot be left
 * open in a production deployment by accident — setting the flag there does nothing.
 *
 * The dev identity is also clearly marked (`isAnonymousDevUser: true`) so downstream code and
 * audit records can tell a real operator from a local convenience.
 */

function devAuthAllowed(): boolean {
  return (
    process.env.ALLOW_ANONYMOUS_DEV_AUTH === 'true' &&
    process.env.NODE_ENV !== 'production'
  );
}

function unauthorized(res: Response, message: string, code = 'AUTH_REQUIRED') {
  return res.status(401).json({ error: { code, message } });
}

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (devAuthAllowed()) {
      req.user = {
        uid: 'dev_anonymous',
        email: 'dev-anonymous@localhost',
        name: 'Anonymous Dev User',
        isAnonymousDevUser: true,
      };
      return next();
    }
    return unauthorized(res, 'A Bearer token is required.');
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token || token.trim() === '') {
    return unauthorized(res, 'Malformed Authorization header.');
  }

  // P0.4 — The hardcoded "demo_bary" bearer token was removed. It minted a named user session
  // from a string constant committed to a public repository.

  if (!firebaseAuth) {
    // P0.4 — This used to accept the token unverified. A backend that cannot verify identity
    // must refuse to act on it, not assume the caller is who they claim to be. 503 rather
    // than 401: the caller's credential may be perfectly valid; it is the server that is
    // unable to check it.
    console.error(
      '[auth] Firebase Auth is not initialised; refusing to verify tokens. ' +
        'This is a server misconfiguration, not a client error.'
    );
    return res.status(503).json({
      error: {
        code: 'AUTH_UNAVAILABLE',
        message: 'Authentication is not available on this server. Refusing to accept unverified credentials.',
      },
    });
  }

  try {
    const decodedToken = await firebaseAuth.verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('[auth] Token verification failed:', error);
    return unauthorized(res, 'Invalid or expired token.', 'AUTH_INVALID');
  }
};
