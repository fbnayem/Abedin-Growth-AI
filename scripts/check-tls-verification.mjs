#!/usr/bin/env node
/**
 * Fail if anything disables TLS certificate verification, or opens a Postgres connection
 * without going through the one module that verifies it.
 *
 * WHY THE CHECK EXISTS
 * --------------------
 * `ssl: { rejectUnauthorized: false }` was at seven call sites, including the pool that carries
 * customers' Gmail access and refresh tokens, and a codemod in `archive_scripts/` whose entire
 * purpose was to write it back into `server/db/index.ts` if anyone ran it. Nothing objected: it
 * is valid TypeScript, it compiles, and it works — a connection is established, queries return
 * rows, and the only thing missing is the part that says who answered.
 *
 * That is the shape this repository keeps finding: a step that completes, reports success, and
 * leaves untrue the thing it was supposed to establish. One line makes it come back, so the
 * check is on the line rather than on anyone remembering.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   1. No `rejectUnauthorized: false`, anywhere, in any form the scanner can recognise.
 *   2. No `NODE_TLS_REJECT_UNAUTHORIZED` assignment, which disables verification process-wide
 *      and would leave rule 1 passing while achieving the same thing.
 *   3. Every `new Pool(` / `new Client(` outside `server/db/tls.ts` is accompanied, in the same
 *      file, by `verifiedPgOptions`. A connection built by hand is a connection that has not
 *      been verified, whatever its ssl option says.
 *
 * WHY IT STRIPS COMMENTS BUT NOT STRINGS
 * --------------------------------------
 * The module that replaces this pattern documents it, at length, in prose that contains the
 * literal text. Scanning comments would fail on the fix. Strings are NOT stripped: the codemod
 * that had to be deleted held the pattern in a string literal, and that is the case worth
 * catching.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server', 'src', 'shared', 'scripts', 'app', 'archive_scripts', '.github'];
const FILES = ['server.ts', 'drizzle.config.ts', 'vite.config.ts', 'vitest.config.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/** The module that is allowed to talk about TLS options, because it is the one that checks. */
const VERIFIER = 'server/db/tls.ts';

/**
 * This file. It holds every pattern it looks for, so scanning itself finds all of them.
 * Exempted by path rather than by any marker a real offender could also carry.
 */
const SELF = 'scripts/check-tls-verification.mjs';

/**
 * Exactly two occurrences in the whole repository are justified, and both are in the verifier
 * so that a reviewer reads them together:
 *
 *   1. PINNED mode. There is no CA to give OpenSSL, and the module checks the certificate
 *      itself on the next line.
 *   2. `inspectServerCertificate`. Taking a pin means looking at a certificate that by
 *      definition nothing can yet verify. It sends no Postgres protocol at all — no startup
 *      message, no user name, no password — and hangs up.
 *
 * Allowed EXACTLY twice, and only while the checks that justify the first are still present. A
 * third occurrence, or these two with the verification gone, fails.
 */
const VERIFIER_ALLOWED_DISABLES = 2;
const VERIFIER_MUST_CONTAIN = [
  'checkPin(cert, plan)',
  'checkCn(cert, plan.expectedCn)',
  'verifyCertificate(this.getPeerCertificate(false), plan)',
];

const RULES = [
  {
    id: 'REJECT_UNAUTHORIZED_FALSE',
    pattern: /rejectUnauthorized\s*:\s*false/,
    say: 'TLS certificate verification is disabled — this accepts any certificate from anyone answering on the address',
  },
  {
    id: 'NODE_TLS_ENV_OFF',
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED/,
    say: 'this disables certificate verification for the whole process, which no per-connection option can undo',
  },
];

/** Comments only. String literals stay, because the pattern hid in one before. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/[^\n]*$/gm, (m) => ' '.repeat(m.length))
    .replace(/([^:])\/\/[^\n]*$/gm, (m, c) => c + ' '.repeat(m.length - 1));
}

const files = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // A root that does not exist is not an error.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(join(dir, entry.name));
    }
  }
}

for (const root of ROOTS) walk(root);
for (const file of FILES) {
  try {
    if (statSync(file).isFile()) files.push(file);
  } catch {
    // Optional file.
  }
}

const offenders = [];

let verifierDisables = 0;

for (const path of files) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (rel === SELF) continue;
  const raw = readFileSync(path, 'utf8');
  const code = stripComments(raw);
  const lines = code.split('\n');

  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (!rule.pattern.test(line)) return;
      if (rel === VERIFIER && rule.id === 'REJECT_UNAUTHORIZED_FALSE') {
        verifierDisables++;
        return;
      }
      offenders.push({ rel, line: i + 1, rule: rule.id, say: rule.say, text: line.trim().slice(0, 110) });
    });
  }

  // Rule 3: a client built by hand, in a file that never mentions the verifier.
  if (rel !== VERIFIER && !code.includes('verifiedPgOptions')) {
    lines.forEach((line, i) => {
      if (/new\s+(?:pg\.)?(?:Pool|Client)\s*\(/.test(line)) {
        offenders.push({
          rel,
          line: i + 1,
          rule: 'UNVERIFIED_PG_CLIENT',
          say: `a Postgres client built without verifiedPgOptions from ${VERIFIER}`,
          text: line.trim().slice(0, 110),
        });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Self-check. A guardrail that cannot fail is worse than no guardrail, because it is mistaken
// for coverage. Each rule is run against text it MUST flag; if any rule matches nothing, the
// scanner is broken and this exits non-zero regardless of what it found in the repository.
// ---------------------------------------------------------------------------
const MUST_FLAG = [
  ['REJECT_UNAUTHORIZED_FALSE', 'const ssl = { rejectUnauthorized: false };'],
  ['REJECT_UNAUTHORIZED_FALSE', "ssl: {rejectUnauthorized:false}"],
  ['NODE_TLS_ENV_OFF', "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';"],
];
const brokenRules = [];
for (const [id, sample] of MUST_FLAG) {
  const rule = RULES.find((r) => r.id === id);
  if (!rule || !rule.pattern.test(stripComments(sample))) brokenRules.push(`${id} did not flag: ${sample}`);
}
// And the inverse: the verifier's own prose must NOT be flagged, or the fix cannot be committed.
if (RULES[0].pattern.test(stripComments('// it used to say rejectUnauthorized: false here'))) {
  brokenRules.push('REJECT_UNAUTHORIZED_FALSE flags its own explanation in a comment');
}
// An empty requirement list requires nothing, and the check that reads it would still print
// "verifier intact". This is the same defect the guardrail exists to catch, one level up: a
// step that completes and establishes nothing. Measured — emptying this list survived a
// mutation run against the whole gate until this check was added.
if (VERIFIER_MUST_CONTAIN.length === 0) {
  brokenRules.push(
    'VERIFIER_MUST_CONTAIN is empty, so the one permitted disable is no longer tied to the ' +
      'checks that justify it'
  );
}
if (VERIFIER_ALLOWED_DISABLES !== 2) {
  brokenRules.push(
    `VERIFIER_ALLOWED_DISABLES is ${VERIFIER_ALLOWED_DISABLES}. Exactly two occurrences are ` +
      'justified and both are in the verifier: PINNED mode, and inspectServerCertificate, ' +
      'which sends no Postgres protocol. Raising the allowance permits unverified connections ' +
      'by arithmetic.'
  );
}

// And a file that legitimately builds a client through the verifier must not trip rule 3.
{
  const sample = stripComments('import { verifiedPgOptions } from "./tls";\nnew pg.Client(verifiedPgOptions(url));');
  if (!sample.includes('verifiedPgOptions')) brokenRules.push('rule 3 cannot see verifiedPgOptions');
}

const MIN_FILES = 60;
if (files.length < MIN_FILES) {
  console.error(
    `check-tls-verification: only ${files.length} files scanned, expected at least ${MIN_FILES}. ` +
      'The walk is not reaching the source tree, so a pass here means nothing.'
  );
  process.exit(1);
}
if (brokenRules.length > 0) {
  console.error('check-tls-verification: the scanner is broken —');
  for (const b of brokenRules) console.error('  ' + b);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// And the verifier must still be the thing it claims to be. If `resolveTlsPlan` stops throwing
// when nothing is configured, every rule above still passes while unverified connections come
// back — the check would be guarding the spelling and not the behaviour.
// ---------------------------------------------------------------------------
if (verifierDisables !== VERIFIER_ALLOWED_DISABLES) {
  console.error(
    `check-tls-verification: ${VERIFIER} disables OpenSSL verification ${verifierDisables} ` +
      `time(s), expected exactly ${VERIFIER_ALLOWED_DISABLES}. Two are justified: PINNED mode, ` +
      'where there is no CA for OpenSSL to use and this module checks the certificate itself, ' +
      'and inspectServerCertificate, which reads a certificate nothing can yet verify and sends ' +
      'no Postgres protocol at all. Any other occurrence is a connection nothing verifies.'
  );
  process.exit(1);
}

try {
  const verifier = readFileSync(VERIFIER, 'utf8');
  for (const needle of VERIFIER_MUST_CONTAIN) {
    if (!verifier.includes(needle)) {
      console.error(
        `check-tls-verification: ${VERIFIER} no longer contains ${needle}. The one place allowed ` +
          'to disable OpenSSL verification is allowed to because it checks the certificate itself; ' +
          'without that check it is the defect this guardrail exists to prevent.'
      );
      process.exit(1);
    }
  }
  if (!/throw new DatabaseTlsError\(\s*\n?\s*'no way to verify the database server/.test(verifier)) {
    console.error(
      `check-tls-verification: ${VERIFIER} no longer refuses when neither a CA nor a pin is ` +
        'configured. Every other rule here would still pass while unverified connections returned.'
    );
    process.exit(1);
  }
} catch {
  console.error(`check-tls-verification: ${VERIFIER} is missing — nothing verifies the database.`);
  process.exit(1);
}

if (offenders.length > 0) {
  for (const o of offenders) {
    console.error(`${o.rel}:${o.line}  ${o.rule}`);
    console.error(`    ${o.text}`);
    console.error(`    ${o.say}`);
  }
  console.error(
    `\n${offenders.length} site(s) reach Postgres without verifying who answered. Build the ` +
      `connection with verifiedPgOptions() from ${VERIFIER}, which establishes and checks the ` +
      'socket before any Postgres protocol — including the password — is written to it.'
  );
  process.exit(1);
}

console.log(
  `check-tls-verification: ok (${files.length} files, ${RULES.length + 1} rules, ` +
    `verifier intact with ${verifierDisables} justified disable).`
);
