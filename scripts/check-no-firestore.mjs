#!/usr/bin/env node
/**
 * Fail if anything starts talking to Firestore again.
 *
 * WHY THIS EXISTS
 * ---------------
 * This system had two datastores and could not say which one held the truth. The producer
 * wrote PostgreSQL — `inboundPipeline` inserting conversations and messages through Drizzle —
 * while the consumer read Firestore: the outbox, the identity and fact stores, the circuit
 * breaker and the action gateway. Every suppression check and campaign guard in the repository
 * therefore enforced against a store the send path did not write. That is the defect S26 and
 * S48 both name, and it is why both stayed PARTIAL with correct-looking code.
 *
 * The Firestore half was also only reachable through an exposure. `server/firebase.ts` used
 * the CLIENT SDK, unauthenticated, with a comment recording why: "to bypass IAM limits".
 * Security rules apply to the client SDK, so `firestore.rules` could not be tightened without
 * denying the server — which is exactly why `allow read, write: if true` was still live with
 * the API key committed to a public repository. The workaround and the exposure were one fact.
 *
 * Both are gone: the collections moved to PostgreSQL (`server/store/index.ts`) and Firebase is
 * now authentication only. The reason `firestore.rules` became deployable is not that
 * credentials arrived — it is that no reader is left to deny. A single re-added import would
 * quietly undo that, and would do it without breaking a test, because the SDK works fine.
 * The damage would appear later, as deny-all rules denying the application.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   SDK_IMPORT      importing `firebase/firestore` or `firebase-admin/firestore` anywhere.
 *   FIRESTORE_HANDLE  a call to `getFirestore(`.
 *   CLIENT_SDK_ON_SERVER  a `firebase/...` client-SDK import inside `server/`. The browser may
 *                   use the client SDK; the server may not, and that distinction is the whole
 *                   reason the rules could not be closed before.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * It reads imports, so it cannot see a dynamic `await import(name)` where `name` is computed,
 * nor a REST call to the Firestore HTTP API. It also does not check the live database: whether
 * the rules are actually deployed is a console fact this repository cannot observe, and
 * `firestore.rules` says so in its own header.
 *
 * Test files are not scanned, because a test that asserts the SDK is absent has to name it —
 * flagging the assertion as the defect teaches people to delete the assertion. That leaves a
 * gap: a test could import Firestore and this would not say so. It would not affect what the
 * product does or whether the rules can be deployed, and `firestoreRules.invariant.test.ts`
 * makes the same assertion over `server/` independently, so the gap is narrow and named
 * rather than closed.
 *
 * Historical one-shot patch scripts (`archive_scripts/`, the root `patch_*.cjs` and
 * `fix_*.cjs`) are NOT scanned. They contain the old imports inside string literals because
 * writing those imports was their job. They are dead, they are excluded by directory and
 * filename rather than by content, and the count of what was skipped is printed on every run
 * so the exclusion cannot quietly grow into a hiding place.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server', 'src', 'shared', 'scripts'];
const FILES = ['server.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

/** This file. It quotes every pattern it looks for. */
const SELF = 'scripts/check-no-firestore.mjs';

/** Dead one-shot rewriters. Excluded by name, and counted out loud. */
const HISTORICAL = (rel) =>
  rel.startsWith('archive_scripts/') ||
  /^(patch|fix|add|seed|test)_[a-z0-9_]+\.cjs$/.test(rel) ||
  rel === 'search.cjs';

const RULES = [
  {
    id: 'SDK_IMPORT',
    test: (line) => /['"](firebase\/firestore|firebase-admin\/firestore)['"]/.test(line),
    say: 'the Firestore SDK is back; the document collections live in PostgreSQL (server/store)',
  },
  {
    id: 'FIRESTORE_HANDLE',
    test: (line) => /\bgetFirestore\s*\(/.test(line),
    say: 'a Firestore handle is being opened',
  },
  {
    id: 'CLIENT_SDK_ON_SERVER',
    serverOnly: true,
    test: (line) => /from\s+['"]firebase\/(app|auth|firestore|storage|functions)['"]/.test(line),
    say: 'the server is using the browser SDK; rules apply to it, which is what kept them open',
  },
];

/** Comments only. server/store/index.ts and this file both document what they replaced. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*(?:\/\/|\*)[^\n]*$/gm, (m) => ' '.repeat(m.length))
    .replace(/([^:])\/\/[^\n]*$/gm, (m, c) => c + ' '.repeat(m.length - 1));
}

const files = [];
let skippedHistorical = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
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
    // Optional.
  }
}
// The historical rewriters live at the repository root and in archive_scripts/, neither of
// which is a scanned root. Counted here so the number printed below is honest about them.
for (const dir of ['.', 'archive_scripts']) {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = (dir === '.' ? entry.name : `${dir}/${entry.name}`).split('\\').join('/');
      if (HISTORICAL(rel)) skippedHistorical++;
    }
  } catch {
    // Optional.
  }
}

/** Offenders in one source, through the same code the scan uses. */
function offendersIn(source, rel = '') {
  const code = stripComments(source);
  const lines = code.split('\n');
  const isServer = rel === 'server.ts' || rel.startsWith('server/');
  const found = [];
  for (const rule of RULES) {
    if (rule.serverOnly && !isServer) continue;
    lines.forEach((line, i) => {
      if (rule.test(line)) {
        found.push({ line: i + 1, rule: rule.id, say: rule.say, text: line.trim().slice(0, 110) });
      }
    });
  }
  return { found, lines: lines.length };
}

const offenders = [];
let linesScanned = 0;

for (const path of files) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (rel === SELF || HISTORICAL(rel)) {
    if (rel !== SELF) skippedHistorical++;
    continue;
  }
  const { found, lines } = offendersIn(readFileSync(path, 'utf8'), rel);
  linesScanned += lines;
  for (const o of found) offenders.push({ rel, ...o });
}

// ---------------------------------------------------------------------------
// Self-check, through offendersIn rather than a copy of its rules.
// ---------------------------------------------------------------------------
const broken = [];
{
  const sample = [
    "import { collection } from 'firebase/firestore';",
    "import { getFirestore } from 'firebase-admin/firestore';",
    'const db = getFirestore(app, config.firestoreDatabaseId);',
    "// import { doc } from 'firebase/firestore' — what this replaced",
    "import { getAuth } from 'firebase/auth';",
    "import { store } from '../store';",
  ].join('\n');

  const onServer = offendersIn(sample, 'server/example.ts').found.map((f) => f.line);
  if (!onServer.includes(1)) broken.push('a firebase/firestore import is no longer flagged');
  if (!onServer.includes(2)) broken.push('a firebase-admin/firestore import is no longer flagged');
  if (!onServer.includes(3)) broken.push('getFirestore( is no longer flagged');
  if (onServer.includes(4)) {
    broken.push('the pattern is flagged inside a comment, so the fix cannot document itself');
  }
  if (!onServer.includes(5)) broken.push('the client SDK on the server is no longer flagged');
  if (onServer.includes(6)) broken.push('importing the document store is flagged — that is the fix');

  // The same client-SDK line in the browser is legitimate and must NOT be flagged.
  const inBrowser = offendersIn(sample, 'src/lib/firebase.ts').found.map((f) => f.line);
  if (inBrowser.includes(5)) {
    broken.push('firebase/auth is flagged in src/, where Google sign-in legitimately uses it');
  }
  if (!inBrowser.includes(1)) broken.push('a firestore import in src/ is not flagged, but should be');
}
if (RULES.length === 0) broken.push('the rule list is empty, so this enforces nothing');

const MIN_FILES = 100;
if (files.length < MIN_FILES) {
  console.error(
    `check-no-firestore: only ${files.length} files scanned, expected at least ${MIN_FILES}. ` +
      'The walk is not reaching the source tree.'
  );
  process.exit(1);
}
if (broken.length > 0) {
  console.error('check-no-firestore: the scanner is broken —');
  for (const b of broken) console.error('  ' + b);
  process.exit(1);
}

if (offenders.length > 0) {
  for (const o of offenders) {
    console.error(`${o.rel}:${o.line}  ${o.rule}`);
    console.error(`    ${o.text}`);
    console.error(`    ${o.say}`);
  }
  console.error(
    `\ncheck-no-firestore: ${offenders.length} offender(s). The document collections are in ` +
      'PostgreSQL now (server/store/index.ts). If Firestore is genuinely needed again, the ' +
      'deploy note in firestore.rules has to be rewritten first — deny-all would stop the app.'
  );
  process.exit(1);
}

console.log(
  `check-no-firestore: ok (${files.length} files, ${linesScanned} lines, ${RULES.length} rules; ` +
    `${skippedHistorical} dead one-shot script(s) excluded by name, not by content).`
);
