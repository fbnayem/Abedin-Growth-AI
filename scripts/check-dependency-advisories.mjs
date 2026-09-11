#!/usr/bin/env node
/**
 * Ratchet the dependency advisory count: it may fall, and it may not rise.
 *
 * WHY A RATCHET AND NOT A THRESHOLD
 * ---------------------------------
 * `npm audit --audit-level=high` passes today, and it passes for a reason unrelated to anything
 * this repository does: there are no high or critical advisories to find. Meanwhile thirteen
 * moderate ones sit under it, one of them (`qs`, through express 4 and body-parser) in the
 * production request path. Failing on moderate immediately would block every change without
 * fixing any of them, and the note that used to stand in for that decision — "advisory for now,
 * tighten later" — is how a number stays where it is indefinitely.
 *
 * So the number is written down. A fourteenth fails the build. A twelfth ALSO fails the build,
 * because a count that has fallen is a fact someone should record rather than a windfall the
 * next reader inherits without knowing why. That is the same shape as the other ratchets here
 * (`check-abstention-ratchet`, `check-prompt-authority`), for the same reason: monotonic
 * progress that cannot be quietly reversed.
 *
 * WHY IT IS NOT IN `npm run verify`
 * ---------------------------------
 * `npm audit` needs the network. A guardrail that fails offline would be disabled within a week
 * — and a guardrail that PASSES when it cannot reach the registry would be worse, because it
 * would report a clean audit that never ran. This runs in CI, where the network is a given, and
 * it fails rather than passes when the audit cannot be performed.
 */

import { execSync } from 'node:child_process';

/**
 * The counts as measured on 2026-09-08, with a reason each root is still present. Lower these
 * when one is resolved; the run fails if you do not.
 *
 *   qs       express 4 -> body-parser -> qs, IN THE PRODUCTION REQUEST PATH. npm reports a fix
 *            as available and `npm audit fix` does not move it: 6.15.3 is the newest express@4
 *            permits, so the real fix is express 5 — a framework upgrade, not a bump.
 *   esbuild  a dev-server request vulnerability reached through drizzle-kit. Not in any deployed
 *            path; the production build is a bundle and runs no dev server. The offered fix
 *            downgrades drizzle-kit to 0.18.1 and takes the migration tooling with it.
 *   uuid     v3/v5/v6 buffer bounds, reached through firebase-admin. This application uses v4
 *            from its own direct dependency. The offered fix downgrades firebase-admin by seven
 *            major versions.
 */
const BASELINE = {
  critical: 0,
  high: 0,
  // 13 -> 6, 2026-09-12: `npm audit fix` (no --force) resolved seven advisories with no change
  // to any direct dependency range — only package-lock.json moved. What remains is NOT all of
  // one kind, and the difference matters:
  //
  //   - four in the drizzle-kit toolchain (drizzle-kit, esbuild, @esbuild-kit/*). Dev-time
  //     only; the offered fix is a semver-MAJOR DOWNGRADE to drizzle-kit 0.18.1.
  //   - express and qs. npm reports a fix as available, and `npm audit fix` did not take it:
  //     it needs express 4 -> 5, which is a major. `qs` is in the PRODUCTION request path, as
  //     the note above says, so this is a live exposure carried deliberately and not a
  //     dev-only leftover.
  moderate: 6,
};

/** Severities that must be zero outright, whatever the baseline says. */
const NEVER_ALLOWED = ['critical', 'high'];

let report;
try {
  // `npm audit` exits non-zero when it finds anything, so the exit code is not the signal — the
  // JSON is. A throw here means the audit did not RUN, which is a failure and not a pass.
  // A fixed command string through the shell. `execFileSync('npm', [...])` cannot work on
  // Windows — npm is `npm.cmd` and node 24 refuses to spawn a `.cmd` without a shell — and
  // `execFileSync('npm.cmd', [...], { shell: true })` earns a deprecation warning for
  // concatenating arguments it has not escaped. There is nothing to escape here: every
  // character of this command is a literal in this file, and no input reaches it.
  const raw = execSync('npm audit --json', {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  report = JSON.parse(raw);
} catch (e) {
  const stdout = e?.stdout;
  if (typeof stdout === 'string' && stdout.trim().startsWith('{')) {
    try {
      report = JSON.parse(stdout);
    } catch {
      report = null;
    }
  }
  if (!report) {
    console.error(
      'check-dependency-advisories: `npm audit --json` could not be run or did not return JSON. ' +
        'This is a FAILURE, not a pass: an audit that did not happen must never be reported as ' +
        'a clean one.'
    );
    console.error(String(e?.message ?? e).slice(0, 500));
    process.exit(1);
  }
}

const found = report?.metadata?.vulnerabilities;
if (!found || typeof found.moderate !== 'number') {
  console.error(
    'check-dependency-advisories: the audit report has no vulnerability counts. Refusing to ' +
      'treat an unreadable report as an empty one.'
  );
  process.exit(1);
}

const problems = [];

for (const severity of NEVER_ALLOWED) {
  if ((found[severity] ?? 0) > 0) {
    problems.push(`${found[severity]} ${severity} advisory/advisories — these must be zero`);
  }
}

for (const [severity, baseline] of Object.entries(BASELINE)) {
  const now = found[severity] ?? 0;
  if (now > baseline) {
    problems.push(
      `${severity}: ${now} advisories, baseline ${baseline}. Something new arrived — resolve it, ` +
        'or raise the baseline in this file WITH the reason it is acceptable.'
    );
  } else if (now < baseline) {
    problems.push(
      `${severity}: ${now} advisories, baseline ${baseline}. This is GOOD and the build still ` +
        'fails, so the improvement is recorded rather than absorbed: lower the baseline here ' +
        'and say which advisory went away.'
    );
  }
}

console.log(
  'advisories: ' +
    Object.entries(found)
      .filter(([k]) => k !== 'total')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ') +
    ` (baseline moderate=${BASELINE.moderate})`
);

if (problems.length > 0) {
  console.error('');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log('check-dependency-advisories: ok — no new advisories, and none above moderate.');
