/**
 * Ask a running server whether it is ready, and report what it actually said.
 *
 *   npm run readiness                     # against http://localhost:3000
 *   npm run readiness -- --url https://…
 *
 * WHAT THIS REPLACES
 * ------------------
 * Two implementations, both of which reported success without establishing it.
 *
 * `scripts/readiness.sh` did this:
 *
 *     if [ ! -f "docs/BACKUP_RESTORE.md" ]; then
 *       mkdir -p docs
 *       echo "# Backup & Restore Process..." > docs/BACKUP_RESTORE.md
 *     fi
 *     echo "✅ Backup procedure documented."
 *
 * It CREATED the document it was checking for, then reported it as present — and the file was
 * not on disk, which proves the script had never completed a run. Its audit step ended in
 * `|| echo "⚠️ Ignoring vulnerabilities for now"`, so it could not fail. Its schema check tested
 * that `server/db/schema.ts` exists. It closed with "All checks passed! Ready for production
 * deployment."
 *
 * The old `scripts/readiness.ts` imported `node-fetch`, which is not in `package.json`, so the
 * exact command the disaster-recovery document mandates threw on any clean install.
 *
 * WHAT IT DOES INSTEAD
 * --------------------
 * One real round trip, on global fetch, and then it believes the response rather than the fact
 * that a response arrived. In particular `verifiesCapability: false` — which the endpoint
 * reports about itself, because its checks still test object existence rather than executed
 * queries (S47) — is surfaced as a caveat rather than swallowed. A READY that the server itself
 * says is not capability-verified is not the same claim as a READY that is, and a script that
 * printed the same tick for both would be doing what the one it replaces did.
 *
 * It never creates anything, never repairs anything, and has no branch that prints success
 * without a 200 and a READY.
 */
import 'dotenv/config';

const urlArg = process.argv.find((a) => a.startsWith('--url='))?.split('=')[1];
const urlFlag = process.argv[process.argv.indexOf('--url') + 1];
const BASE =
  urlArg ??
  (process.argv.includes('--url') && urlFlag && !urlFlag.startsWith('--') ? urlFlag : null) ??
  process.env.READINESS_URL ??
  'http://localhost:3000';

const TIMEOUT_MS = 10_000;

interface ReadinessBody {
  status?: string;
  checks?: {
    databaseConnectivity?: boolean;
    verifiesCapability?: boolean;
    safeRebuildMode?: Record<string, boolean>;
  };
}

(async () => {
  const target = `${BASE.replace(/\/$/, '')}/api/readiness`;
  let response: Response;

  try {
    // An explicit deadline: a probe that hangs is a probe that reports nothing, and a CI step
    // waiting on it forever looks the same as one still working.
    response = await fetch(target, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    console.error(`NOT READY: could not reach ${target} — ${(e as Error).message}`);
    process.exit(1);
  }

  if (response.status !== 200) {
    console.error(`NOT READY: ${target} answered ${response.status}`);
    console.error((await response.text()).slice(0, 500));
    process.exit(1);
  }

  let body: ReadinessBody;
  try {
    body = (await response.json()) as ReadinessBody;
  } catch {
    console.error(`NOT READY: ${target} answered 200 with a body that is not JSON.`);
    process.exit(1);
  }

  if (body.status !== 'READY') {
    console.error(`NOT READY: the server reports status ${JSON.stringify(body.status)}`);
    console.error(JSON.stringify(body, null, 2).slice(0, 1500));
    process.exit(1);
  }

  // Also report the build, so a readiness run says WHICH build was ready. A green check against
  // an unidentified artifact answers nothing during the incident it exists for.
  let build = '(unavailable)';
  try {
    const health = await fetch(`${BASE.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const h = (await health.json()) as { build?: { sha?: string; source?: string } };
    build = h.build ? `${h.build.sha ?? 'unknown'} (${h.build.source})` : '(not reported)';
  } catch {
    // Non-fatal: readiness is the question being asked. The build line is context.
  }

  console.log(`READY: ${target}`);
  console.log(`build: ${build}`);

  // The caveat the server states about itself, repeated rather than dropped.
  if (body.checks?.verifiesCapability !== true) {
    console.log('');
    console.log(
      'CAVEAT: the server reports verifiesCapability=false. Its checks test that objects exist, ' +
        'not that they work — no query is executed and Postgres is not probed (S47). READY here ' +
        'means the process is up and configured, not that a required dependency can perform its ' +
        'function.'
    );
  }
  process.exit(0);
})().catch((e: Error) => {
  console.error('NOT READY: ' + e.message);
  process.exit(1);
});
