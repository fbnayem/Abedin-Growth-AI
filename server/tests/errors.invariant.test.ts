import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  ErrorCodes,
  REQUEST_ID_HEADER,
  asyncHandler,
  requestId,
  sendCaught,
  sendError,
  terminalErrorHandler,
} from '../lib/errors';

/**
 * INVARIANTS (addendum §12, §11 / P1.12).
 *
 * §12 Every failure has the same shape: a stable machine-readable code, a message safe to show
 *     a person, and a request id that appears in the server log for the same request.
 * §11 Internal detail does not leave the server. `e.message` from Firestore, Postgres or the
 *     model SDK is reconnaissance — collection paths, constraint names, query fragments — and
 *     on this deployment those paths are tenant paths.
 *
 * Twenty-seven handlers answered `res.status(500).json({ error: e.message })`, and several
 * more used a bare string. Because `error` was sometimes a string and sometimes an object, the
 * only thing the UI could do was check `res.ok` — which is why a 404 on every pipeline stage
 * change went unnoticed for the life of the feature.
 */

function makeReq(over: Record<string, unknown> = {}) {
  return {
    headers: {},
    method: 'POST',
    originalUrl: '/api/thing',
    requestId: 'req-fixed',
    ...over,
  } as any;
}

function makeRes() {
  const captured: {
    status: number;
    body: any;
    headers: Record<string, string>;
    headersSent: boolean;
  } = { status: 200, body: null, headers: {}, headersSent: false };

  const res: any = {
    get headersSent() {
      return captured.headersSent;
    },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: any) {
      captured.body = body;
      captured.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
  };
  return { res, captured };
}

let errorLog: unknown[][];

beforeEach(() => {
  errorLog = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorLog.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('§12 — every request carries an id', () => {
  it('assigns one when none is supplied, and echoes it', () => {
    const req = makeReq({ requestId: undefined });
    const { res, captured } = makeRes();
    let called = false;

    requestId(req, res, () => {
      called = true;
    });

    expect(called).toBe(true);
    expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(captured.headers[REQUEST_ID_HEADER]).toBe(req.requestId);
  });

  it('honours a well-formed inbound id, so a trace survives a proxy', () => {
    const req = makeReq({ requestId: undefined, headers: { [REQUEST_ID_HEADER]: 'trace-abc_123' } });
    const { res } = makeRes();
    requestId(req, res, () => {});
    expect(req.requestId).toBe('trace-abc_123');
  });

  it('REJECTS a hostile inbound id rather than putting it in a log line', () => {
    // The id is written into log lines; an unbounded or newline-bearing value is a log
    // injection primitive, and a forged one poisons a trace.
    const hostile = [
      'a'.repeat(200),
      'has space',
      'line\nbreak',
      '../../etc/passwd',
      '<script>',
      '',
    ];
    for (const value of hostile) {
      const req = makeReq({ requestId: undefined, headers: { [REQUEST_ID_HEADER]: value } });
      const { res } = makeRes();
      requestId(req, res, () => {});
      expect(req.requestId, JSON.stringify(value)).not.toBe(value);
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('§11 — internal detail never reaches the caller', () => {
  it('does NOT echo the underlying error message', () => {
    const leak = new Error(
      'FirebaseError: Missing or insufficient permissions on organizations/acme/contacts'
    );
    const req = makeReq();
    const { res, captured } = makeRes();

    sendCaught(req, res, leak);

    expect(captured.status).toBe(500);
    expect(JSON.stringify(captured.body)).not.toContain('organizations/acme/contacts');
    expect(JSON.stringify(captured.body)).not.toContain('insufficient permissions');
    expect(captured.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('DOES log the underlying error, correlated by request id', () => {
    const leak = new Error('constraint contacts_org_email_key_unique violated');
    const req = makeReq();
    const { res } = makeRes();

    sendCaught(req, res, leak);

    const logged = JSON.stringify(errorLog);
    expect(logged).toContain('req-fixed');
    expect(errorLog.some((args) => args.includes(leak))).toBe(true);
  });

  it('puts the request id in the body, so a report can be traced', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    sendCaught(req, res, new Error('x'));
    expect(captured.body.error.requestId).toBe('req-fixed');
  });
});

// ---------------------------------------------------------------------------
describe('§12 — the envelope is the same shape every time', () => {
  it('always has code, message and requestId', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    sendError(req, res, 'NOT_FOUND', 'No such record.');

    expect(Object.keys(captured.body)).toEqual(['error']);
    expect(captured.body.error.code).toBe('NOT_FOUND');
    expect(captured.body.error.message).toBe('No such record.');
    expect(captured.body.error.requestId).toBe('req-fixed');
  });

  it('omits details rather than sending an empty object', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    sendError(req, res, 'NOT_FOUND', 'No such record.');
    expect(captured.body.error).not.toHaveProperty('details');
  });

  it('carries structured details when the caller needs them to recover', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    sendError(req, res, 'VERSION_CONFLICT', 'Changed.', { details: { currentVersion: 7 } });
    expect(captured.body.error.details).toEqual({ currentVersion: 7 });
  });

  it('maps each code to its correct status', () => {
    const expected: [keyof typeof ErrorCodes, number][] = [
      ['VALIDATION_ERROR', 400],
      ['AUTH_REQUIRED', 401],
      ['TENANT_FORBIDDEN', 403],
      ['NOT_FOUND', 404],
      ['VERSION_CONFLICT', 409],
      ['ILLEGAL_TRANSITION', 422],
      ['VERSION_REQUIRED', 428],
      ['PROVIDER_RATE_LIMITED', 429],
      ['INTERNAL_ERROR', 500],
      ['STORE_UNAVAILABLE', 503],
    ];
    for (const [code, status] of expected) {
      const req = makeReq();
      const { res, captured } = makeRes();
      sendError(req, res, code, 'x');
      expect(captured.status, code).toBe(status);
    }
  });

  it('does not attempt a second response once one has been sent', () => {
    // Double-send throws ERR_HTTP_HEADERS_SENT and crashes the handler rather than the request.
    const req = makeReq();
    const { res, captured } = makeRes();
    sendError(req, res, 'NOT_FOUND', 'first');
    sendError(req, res, 'INTERNAL_ERROR', 'second');
    expect(captured.body.error.message).toBe('first');
  });
});

// ---------------------------------------------------------------------------
describe('§12 — the terminal handler catches what handlers do not', () => {
  it('reports an ApiError with its own code and status', () => {
    const req = makeReq();
    const { res, captured } = makeRes();

    terminalErrorHandler(
      new ApiError('NOT_FOUND', 'No such meeting.', { details: { id: 'm1' } }),
      req,
      res,
      () => {}
    );

    expect(captured.status).toBe(404);
    expect(captured.body.error.code).toBe('NOT_FOUND');
    expect(captured.body.error.details).toEqual({ id: 'm1' });
  });

  it('turns an unrecognised throw into a generic 500 that leaks nothing', () => {
    const req = makeReq();
    const { res, captured } = makeRes();

    terminalErrorHandler(new Error('ECONNREFUSED 10.0.0.5:5432'), req, res, () => {});

    expect(captured.status).toBe(500);
    expect(captured.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(captured.body)).not.toContain('10.0.0.5');
    expect(captured.body.error.requestId).toBe('req-fixed');
  });

  it('handles a thrown non-Error without crashing', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    terminalErrorHandler('just a string', req, res, () => {});
    expect(captured.status).toBe(500);
  });

  it('stays silent if the response has already gone out', () => {
    const req = makeReq();
    const { res, captured } = makeRes();
    res.json({ ok: true });
    terminalErrorHandler(new Error('late'), req, res, () => {});
    expect(captured.body).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe('§12 — an async rejection reaches the handler instead of hanging', () => {
  it('forwards a rejected promise to next()', async () => {
    // Express 4 does not catch async rejections: an await that throws outside try/catch becomes
    // an unhandled rejection and the request hangs until the client times out.
    const boom = new Error('async boom');
    let forwarded: unknown = null;

    const wrapped = asyncHandler(async () => {
      throw boom;
    });
    wrapped(makeReq(), makeRes().res, (err: unknown) => {
      forwarded = err;
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(forwarded).toBe(boom);
  });

  it('does not call next on success', async () => {
    let called = false;
    const wrapped = asyncHandler(async () => 'fine');
    wrapped(makeReq(), makeRes().res, () => {
      called = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(called).toBe(false);
  });
});
