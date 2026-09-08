import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  safeField,
  reportsFrom,
  summarise,
  MAX_REPORTS_PER_REQUEST,
} from '../routes/cspReport.routes';
import { contentSecurityPolicy, CSP_REPORT_PATH } from '../middleware/securityHeaders';
import { isUnauthenticatedApiPath } from '../middleware/authAllowlist';

/**
 * INVARIANTS FOR CSP REPORTING (addendum S35).
 *
 * The policy landed without `report-uri` or `report-to`, and the status document recorded that
 * as a remainder. A CSP with no reporting is a control whose only feedback channel is a
 * customer saying the page looks wrong — in one direction a silently broken feature, in the
 * other a real injection into an origin that renders inbound email from strangers, producing
 * no signal at all.
 *
 * The endpoint is unauthenticated by necessity, so its body is entirely attacker-controlled.
 * Most of this file is about that.
 */

describe('1. the policy says where to report, in both spellings', () => {
  it('report-uri is present regardless of configuration', () => {
    // Relative, so it works with no environment variable at all. Reporting is never silently
    // off because somebody did not set APP_URL.
    for (const development of [true, false]) {
      const policy = contentSecurityPolicy({ development });
      expect(policy, `development=${development}`).toContain(`report-uri ${CSP_REPORT_PATH}`);
    }
  });

  it('report-to appears only when an absolute origin exists to name', () => {
    // `report-to csp` is inert without a `Reporting-Endpoints` header naming that group, and a
    // directive pointing at a group nothing defines is a control that looks present and does
    // nothing — the exact failure this whole audit keeps finding.
    expect(contentSecurityPolicy({ development: false, reportTo: true })).toContain('report-to csp');
    expect(contentSecurityPolicy({ development: false, reportTo: false })).not.toContain('report-to');
    expect(contentSecurityPolicy({ development: false })).not.toContain('report-to');
  });

  it('adding reporting did not disturb the rest of the policy', () => {
    // The directives were being built by one expression and are now built by two, which is
    // exactly the kind of refactor that silently drops a line.
    const policy = contentSecurityPolicy({ development: false });
    for (const directive of [
      "default-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      'upgrade-insecure-requests',
    ]) {
      expect(policy, `${directive} was lost`).toContain(directive);
    }
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it('the report path is one constant, used everywhere', () => {
    // It appears in the directive, the Reporting-Endpoints header and the route mount. Three
    // copies of a path is three chances for reporting to point somewhere that does not exist.
    const server = readFileSync('server.ts', 'utf8');
    const headers = readFileSync('server/middleware/securityHeaders.ts', 'utf8');
    expect(server).toContain('CSP_REPORT_PATH');
    expect(headers).toContain('CSP_REPORT_PATH');
    expect(server).not.toContain("'/api/csp-report'");
    // ...and the allowlist entry matches it, since that is mount-relative rather than absolute.
    expect(isUnauthenticatedApiPath(CSP_REPORT_PATH.replace(/^\/api/, ''))).toBe(true);
  });
});

describe('2. the report body is attacker-controlled and is treated that way', () => {
  it('control characters cannot forge a log line', () => {
    // The same defect as the attachment filename in S17: a value that can end a log entry can
    // begin a convincing one of its own.
    const forged = safeField('https://evil\n[INFO] csp: all clear');
    expect(forged).not.toContain('\n');
    expect(safeField('a\r\nb')).toBe('a??b');
    expect(safeField('x\u0000y')).toBe('x?y');
  });

  it('a very long field is truncated', () => {
    const long = safeField('x'.repeat(50_000));
    expect(long!.length).toBeLessThanOrEqual(512);
    expect(long!.endsWith('...')).toBe(true);
  });

  it('non-strings are dropped rather than coerced', () => {
    for (const bad of [null, undefined, {}, [], true, NaN, Infinity, '']) {
      expect(safeField(bad), `accepted ${JSON.stringify(bad)}`).toBeNull();
    }
    // A line number is legitimately a number.
    expect(safeField(42)).toBe('42');
  });

  it('the summary only ever contains fields we asked for', () => {
    // A report is a caller-supplied object. Logging it whole would put arbitrary attacker keys
    // and values into the log, in arbitrary volume.
    const summary = summarise({
      'document-uri': 'https://app.example.com/inbox',
      'blocked-uri': 'https://evil.example.com/x.js',
      'violated-directive': 'script-src',
      'attacker-key': 'SHOULD NOT APPEAR',
      padding: 'y'.repeat(100_000),
    });
    expect(summary).toContain('document-uri=https://app.example.com/inbox');
    expect(summary).toContain('blocked-uri=https://evil.example.com/x.js');
    expect(summary).not.toContain('SHOULD NOT APPEAR');
    expect(summary).not.toContain('attacker-key');
    expect(summary).not.toContain('padding');
    expect(summary.length).toBeLessThan(4000);
  });

  it('a report with nothing recognisable says so rather than logging an empty line', () => {
    expect(summarise({})).toBe('(no recognised fields)');
    expect(summarise({ nonsense: 1 })).toBe('(no recognised fields)');
  });
});

describe('3. both wire formats are understood', () => {
  it('the legacy application/csp-report shape', () => {
    const reports = reportsFrom({
      'csp-report': { 'document-uri': 'https://a/', 'violated-directive': 'script-src' },
    });
    expect(reports).toHaveLength(1);
    expect(summarise(reports[0])).toContain('violated-directive=script-src');
  });

  it('the Reporting API array shape, with camelCase field names', () => {
    // Same policy, same violation, different browser: the newer format nests the report under
    // `body` and renames every field. Handling only one is handling only some browsers.
    const reports = reportsFrom([
      { type: 'csp-violation', body: { documentURL: 'https://a/', effectiveDirective: 'script-src' } },
    ]);
    expect(reports).toHaveLength(1);
    expect(summarise(reports[0])).toContain('effective-directive=script-src');
  });

  /**
   * THE MAPPING THAT WAS WRONG, AND THE REASON IT LOOKED RIGHT.
   *
   * `blocked-uri` camelCases to `blockedUri`; the Reporting API calls it `blockedURL`. So every
   * violation from a browser using the newer format summarised as "(no recognised fields)" —
   * reporting that appeared to work and reported nothing. `effective-directive` transforms
   * correctly by coincidence, which is why the first test written passed.
   *
   * Every field is checked here, rather than one representative, because the coincidence is
   * per-field.
   */
  it('every Reporting API field name maps to its legacy field', () => {
    const report = {
      documentURL: 'https://app.example.com/inbox',
      effectiveDirective: 'script-src',
      blockedURL: 'https://evil.example.com/x.js',
      sourceFile: 'https://app.example.com/main.js',
      lineNumber: 12,
      disposition: 'enforce',
    };
    const summary = summarise(report);
    for (const expected of [
      'document-uri=https://app.example.com/inbox',
      'effective-directive=script-src',
      'blocked-uri=https://evil.example.com/x.js',
      'source-file=https://app.example.com/main.js',
      'line-number=12',
      'disposition=enforce',
    ]) {
      expect(summary, `${expected} was not recovered`).toContain(expected);
    }
  });

  it('non-CSP reports in a batch are ignored', () => {
    // The Reporting API multiplexes deprecation and intervention reports down the same pipe.
    const reports = reportsFrom([
      { type: 'deprecation', body: { id: 'x' } },
      { type: 'csp-violation', body: { blockedURL: 'https://evil/' } },
    ]);
    expect(reports).toHaveLength(1);
    expect(summarise(reports[0])).toContain('blocked-uri=https://evil/');
  });

  it('a body of any other shape yields nothing, and never throws', () => {
    for (const body of [null, undefined, '', 'text', 42, [], {}, { 'csp-report': 'nope' }, [null, 1, 'x']]) {
      expect(() => reportsFrom(body)).not.toThrow();
      expect(reportsFrom(body), `body ${JSON.stringify(body)}`).toHaveLength(0);
    }
  });

  it('a batch is capped', () => {
    // The Reporting API batches, and the batch size is chosen by the sender. Without a cap one
    // request writes as many log lines as they feel like.
    const huge = Array.from({ length: 500 }, () => ({ type: 'csp-violation', body: { blockedURL: 'https://x/' } }));
    expect(reportsFrom(huge).length).toBe(500);
    expect(MAX_REPORTS_PER_REQUEST).toBeLessThanOrEqual(25);
    const routes = readFileSync('server/routes/cspReport.routes.ts', 'utf8');
    expect(routes).toMatch(/slice\(0, MAX_REPORTS_PER_REQUEST\)/);
  });
});

describe('4. the endpoint writes nothing and cannot be defeated by the body parser', () => {
  const routes = readFileSync('server/routes/cspReport.routes.ts', 'utf8');
  const server = readFileSync('server.ts', 'utf8');

  it('nothing in the route reaches a datastore', () => {
    // An unauthenticated endpoint that persists is an unauthenticated write. This one logs,
    // and the log is the product.
    //
    // Comments are stripped first. The first version of this failed on the word "datastore" in
    // the module's own header, which is the fix explaining itself being read as the defect —
    // the same mistake made twice already in this hardening pass, on the credential-file check
    // and on the automated-mail classifier.
    const code = routes.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const forbidden of ['setDoc', 'addDoc', 'updateDoc', 'db.insert', 'runTransaction', 'from \'../store\'']) {
      expect(code, `the CSP report route references ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('that check would catch a route that persisted', () => {
    const sample = "await setDoc(doc(store, 'reports', id), report);";
    const code = sample.replace(/\/\*[\s\S]*?\*\//g, ' ');
    expect(code).toContain('setDoc');
  });

  it('the parser is mounted BEFORE the global express.json()', () => {
    // S33: `express.json()` sets `req._body = true`, which silently defeats a route-level
    // parser mounted after it — that is how Stripe signature verification came to reject every
    // genuine event. The content types here happen not to overlap, and relying on that is how
    // the bug came back the first time.
    const parserAt = server.indexOf('application/csp-report');
    const globalJsonAt = server.indexOf('app.use(express.json());');
    expect(parserAt).toBeGreaterThan(-1);
    expect(globalJsonAt).toBeGreaterThan(-1);
    expect(parserAt, 'the CSP parser is mounted after the global JSON parser').toBeLessThan(
      globalJsonAt
    );
  });

  it('the body is size-capped', () => {
    expect(server).toMatch(/limit:\s*'16kb'/);
  });

  it('it answers 204 to every body', () => {
    // Browsers do not read the status, do not retry on it, and telling an anonymous caller
    // which bodies this endpoint understands is an oracle for no benefit.
    expect(routes).toMatch(/res\.status\(204\)\.end\(\)/);
    expect(routes).not.toMatch(/res\.status\(4\d\d\)/);
  });

  it('those checks would fail on the versions they are meant to prevent', () => {
    expect(/res\.status\(4\d\d\)/.test('res.status(400).json({ error: "bad report" });')).toBe(true);
    expect('await setDoc(ref, report);').toContain('setDoc');
  });
});
