import { getFirebaseIdToken } from './firebase';

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url = '';
  if (typeof input === 'string') {
    url = input;
  } else if (input instanceof URL) {
    url = input.toString();
  } else if (input instanceof Request) {
    url = input.url;
  }

  if (url.startsWith('/api')) {
    const token = await getFirebaseIdToken();
    if (token) {
      init = init || {};
      init.headers = {
        ...init.headers,
        'Authorization': `Bearer ${token}`
      };
    }
  }
  
  return fetch(input, init);
}

/**
 * P1.12 — The client side of the error envelope.
 *
 * Every failure now arrives as `{ error: { code, message, requestId, details? } }`. Before
 * that, `error` was sometimes a string and sometimes an object, so the only thing a caller
 * could reliably do was check `res.ok` — which is why a 404 on every pipeline stage change
 * went unnoticed for the life of the feature.
 *
 * `code` is what to branch on. `message` is safe to show a person. `requestId` is what to put
 * in a bug report: it appears in the server log for the same request.
 */
export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

/**
 * Read the error envelope from a failed response.
 *
 * Falls back to a synthetic envelope when the body is not JSON or does not carry one, so a
 * caller never has to handle "sometimes an object, sometimes nothing". A proxy timeout page is
 * still a failure and still needs a code to branch on.
 */
export async function readApiError(res: Response): Promise<ApiErrorBody> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  try {
    const body = await res.json();
    const error = body?.error;
    if (error && typeof error.code === 'string') {
      return { requestId, ...error };
    }
    // A pre-P1.12 shape, or a body from something that is not this server.
    if (typeof error === 'string') {
      return { code: `HTTP_${res.status}`, message: error, requestId };
    }
  } catch {
    // Not JSON.
  }
  return {
    code: `HTTP_${res.status}`,
    message: res.statusText || 'The request failed.',
    requestId,
  };
}

/**
 * Fetch and parse, or throw an error carrying the code.
 *
 * For callers that want the happy path inline. Callers that need to handle a specific code —
 * a 409 on a concurrent edit, say — should use `apiFetch` and `readApiError` so they can
 * branch without catching.
 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId?: string;
  readonly details?: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiRequestError';
    this.code = body.code;
    this.status = status;
    this.requestId = body.requestId;
    this.details = body.details;
  }
}

export async function apiJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await apiFetch(input, init);
  if (!res.ok) {
    throw new ApiRequestError(res.status, await readApiError(res));
  }
  return (await res.json()) as T;
}
