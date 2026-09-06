/**
 * P0.5 — HTTP client with a mandatory timeout.
 *
 * WHAT WAS WRONG
 * --------------
 * `grep -rE "AbortController|signal:|timeout" server/` returned nothing: not one outbound
 * request in the backend had a timeout. Node's fetch has no default one, so a hung Google
 * connection blocks until the OS gives up, which can be minutes.
 *
 * That interacts badly with the outbox worker, which runs `setInterval(() => this.processQueue(),
 * 5000)` without awaiting the previous tick and without a re-entrancy guard. With no timeout,
 * every stalled request leaves a tick in flight and a new one starts 5 seconds later, so
 * concurrent in-flight work grows without bound while the queue makes no progress.
 *
 * USAGE
 * -----
 * Use this instead of bare `fetch` for every outbound provider call. The timeout is a required
 * concept here rather than an option someone can forget: omitting it selects a default, and
 * there is no way to request "no timeout".
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export class HttpTimeoutError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
  readonly isTimeout = true;
  constructor(url: string, ms: number) {
    super(`Request to ${url} timed out after ${ms}ms`);
    this.name = 'HttpTimeoutError';
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

/**
 * fetch() that always aborts. Clears its timer on every path so a long-lived process does not
 * accumulate timers.
 *
 * IMPORTANT for irreversible actions (send, calendar create, payment): a timeout is NOT proof
 * the request did not take effect. The provider may have completed it and the response been
 * lost. Callers performing irreversible actions must treat HttpTimeoutError as AMBIGUOUS and
 * reconcile against the provider before retrying — see addendum §32 / P0 reconciliation work.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, ...init } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new HttpTimeoutError(url, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
