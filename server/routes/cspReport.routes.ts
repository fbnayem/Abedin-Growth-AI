import { Router } from 'express';

/**
 * S35 — WHERE THE CONTENT SECURITY POLICY REPORTS TO.
 *
 * WHAT WAS MISSING
 * ----------------
 * The policy landed with no `report-uri` and no `report-to`, which the status document recorded
 * as a remainder. A CSP with no reporting is a control whose only feedback channel is a
 * customer saying the page looks wrong.
 *
 * It matters most in the two directions the policy is least certain about. If a directive is
 * too tight, the symptom is a silently broken feature nobody connects to a header. If a
 * directive is too loose, an actual injection into this origin — which renders inbound email
 * text from strangers — produces no signal at all. Reports are how either becomes visible.
 *
 * THIS ENDPOINT IS UNAUTHENTICATED, AND IT WRITES NOTHING
 * ------------------------------------------------------
 * The caller is a browser, and it will not hold a credential. So the body is entirely
 * attacker-controlled: anyone can POST anything here, in any volume.
 *
 * Two consequences, both deliberate:
 *
 *   - IT DOES NOT PERSIST. There is no store write, so this endpoint cannot be used to fill a
 *     datastore or to place attacker-chosen strings where something later trusts them. It logs,
 *     and the log is the product.
 *   - EVERY FIELD IS NEUTRALISED AND TRUNCATED before it reaches that log. A `blocked-uri`
 *     containing a newline could forge a log line, which is the same class of defect as the
 *     attachment filename in S17 — and a 40KB one is a denial of readability.
 *
 * Rate limiting is by IP, through the same limiter the webhooks use, because there is no user
 * to key on.
 *
 * WHY GET AND PUT ARE NOT HERE
 * ----------------------------
 * Browsers POST reports. Nothing else should reach this path, and a route that answers more
 * verbs than it needs is a larger surface for no benefit.
 */
export const cspReportRouter = Router();

/** Longer than this is not a URI or a directive; it is somebody using a log as storage. */
const MAX_FIELD = 512;

/** The fields worth keeping. Everything else in a report is noise or duplication. */
const REPORTED_FIELDS = [
  'document-uri',
  'violated-directive',
  'effective-directive',
  'blocked-uri',
  'source-file',
  'line-number',
  'disposition',
] as const;

/**
 * A report field, rendered safe to put in a log line.
 *
 * Control characters become `?` so a value cannot end this log entry and begin a convincing
 * one of its own. Same reasoning as `displayName` in `server/domain/attachmentPolicy.ts`, and
 * for the same reason: this string is chosen by whoever sent the request.
 */
export function safeField(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string' || value.length === 0) return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, '?');
  return cleaned.length > MAX_FIELD ? `${cleaned.slice(0, MAX_FIELD - 3)}...` : cleaned;
}

/**
 * Pull the report out of either shape the browser might send.
 *
 * Legacy (`application/csp-report`) is `{ "csp-report": { ... } }`. The Reporting API
 * (`application/reports+json`) is an ARRAY of `{ type, body: { ... } }`, and its field names
 * are camelCase rather than hyphenated. Both are handled because both are still sent, by
 * different browsers, for the same policy.
 *
 * Returns an empty array rather than throwing: a body this does not recognise is not an error
 * worth answering with a 400, because nothing is listening to the status code.
 */
export function reportsFrom(body: unknown): Array<Record<string, unknown>> {
  if (body === null || typeof body !== 'object') return [];

  if (Array.isArray(body)) {
    return body
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .filter((entry) => entry.type === undefined || entry.type === 'csp-violation')
      .map((entry) => (entry.body !== null && typeof entry.body === 'object' ? (entry.body as Record<string, unknown>) : entry));
  }

  const legacy = (body as Record<string, unknown>)['csp-report'];
  if (legacy !== null && typeof legacy === 'object') return [legacy as Record<string, unknown>];
  return [];
}

/**
 * The Reporting API's name for each legacy field.
 *
 * AN EXPLICIT TABLE, NOT A camelCase TRANSFORM, and a test is what forced that. The transform
 * turns `blocked-uri` into `blockedUri`, and the Reporting API calls it `blockedURL` — so every
 * violation from a browser using the newer format logged as "(no recognised fields)" while
 * appearing to be handled. `effective-directive` happens to transform correctly, which is
 * exactly why the first test written passed and the second did not.
 *
 * A mapping that is right for some inputs by coincidence is worse than one that is wrong for
 * all of them, because nothing looks broken.
 */
const REPORTING_API_NAMES: Readonly<Record<string, string>> = {
  'document-uri': 'documentURL',
  'violated-directive': 'effectiveDirective',
  'effective-directive': 'effectiveDirective',
  'blocked-uri': 'blockedURL',
  'source-file': 'sourceFile',
  'line-number': 'lineNumber',
  disposition: 'disposition',
};

/** The same field under either name: hyphenated (legacy) or the Reporting API's own spelling. */
function fieldOf(report: Record<string, unknown>, name: string): unknown {
  if (Object.prototype.hasOwnProperty.call(report, name)) return report[name];
  const alias = REPORTING_API_NAMES[name];
  if (alias !== undefined && Object.prototype.hasOwnProperty.call(report, alias)) {
    return report[alias];
  }
  return undefined;
}

/** One log line per report, built only from fields we asked for. */
export function summarise(report: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const name of REPORTED_FIELDS) {
    const value = safeField(fieldOf(report, name));
    if (value !== null) parts.push(`${name}=${value}`);
  }
  return parts.length === 0 ? '(no recognised fields)' : parts.join(' ');
}

/**
 * At most this many reports are logged from one request body.
 *
 * The Reporting API batches, and a batch is caller-supplied. Without a cap, one request writes
 * as many log lines as the sender feels like.
 */
export const MAX_REPORTS_PER_REQUEST = 10;

cspReportRouter.post('/', (req, res) => {
  const reports = reportsFrom(req.body);
  const shown = reports.slice(0, MAX_REPORTS_PER_REQUEST);

  for (const report of shown) {
    console.warn(`[csp] ${summarise(report)}`);
  }
  if (reports.length > shown.length) {
    console.warn(`[csp] ${reports.length - shown.length} further report(s) in this batch not logged.`);
  }

  // 204 whatever the body was. Browsers do not read this, do not retry on it, and telling an
  // anonymous caller which bodies this endpoint understands is an oracle for no benefit.
  res.status(204).end();
});
