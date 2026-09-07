#!/usr/bin/env node
/**
 * Fail if a request body reaches a datastore write without being validated first.
 *
 * WHY THIS EXISTS
 * ---------------
 * Six handlers spread `req.body` straight into Firestore. Every field a caller sent was
 * persisted, including fields the application had never heard of.
 *
 * The one that mattered most did not look dangerous. `POST /api/company-brain` wrote a whole
 * body, and the company brain is **stringified into every outbound prompt** — so a key written
 * there is a key the model reads as part of its instructions. That is the prompt-injection
 * channel §18 describes, reached through an ordinary authenticated API call rather than through
 * a retrieved document, which is where the control was looking for it.
 *
 * `zod` was already a dependency. Its only import in the repository was in a file proven
 * unreachable, validating model output rather than an HTTP body.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   BODY_SPREAD        `{ ...req.body }` — the literal mass assignment.
 *   BODY_TO_WRITE      `req.body` passed as an argument to a datastore write (`setDoc`,
 *                      `addDoc`, `updateDoc`, `.values(`, `writeSingleton`) in the same call.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * It does not verify that a route's schema is CORRECT, or that a validated field is safe. It
 * catches the unvalidated body reaching a write, which is one specific mistake with one
 * specific spelling. Reading `req.body.someField` and writing that single value is not flagged
 * — that is a projection, and a projection is the fix rather than the defect.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server'];
const FILES = ['server.ts'];
const EXTENSIONS = ['.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

/** This file. It contains every pattern it looks for, in the prose explaining them. */
const SELF = 'scripts/check-no-mass-assignment.mjs';

const WRITES = ['setDoc', 'addDoc', 'updateDoc', 'writeSingleton', '.values('];

const RULES = [
  {
    id: 'BODY_SPREAD',
    test: (line) => /\.\.\.\s*req\.body\b/.test(line),
    say: 'the whole request body is spread into an object — every field a caller sends is kept',
  },
  {
    id: 'BODY_TO_WRITE',
    test: (line) => /\breq\.body\b/.test(line) && WRITES.some((w) => line.includes(w)),
    say: 'an unvalidated request body is passed to a datastore write',
  },
];

/** Comments only. The fix documents the pattern it replaced, at length. */
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

/** The offenders in one source, and how many lines were looked at. */
function offendersIn(source) {
  const found = [];
  const lines = stripComments(source).split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.test(line)) {
        found.push({ line: i + 1, rule: rule.id, say: rule.say, text: line.trim().slice(0, 110) });
      }
    }
  });
  return { found, lines: lines.length };
}

const offenders = [];
let linesScanned = 0;

for (const path of files) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (rel === SELF) continue;
  const { found, lines } = offendersIn(readFileSync(path, 'utf8'));
  linesScanned += lines;
  for (const o of found) offenders.push({ rel, ...o });
}

// ---------------------------------------------------------------------------
// Self-check, through the same function the scan uses rather than a copy of it.
// ---------------------------------------------------------------------------
const broken = [];
{
  const sample = [
    'const payload = { ...req.body, id: 1 };',
    "await setDoc(ref, req.body);",
    "await writeSingleton(req, res, 'settings', req.body || {});",
    '// { ...req.body } in a comment is the fix explaining itself',
    "await setDoc(ref, parsedBody);",
    'const name = req.body.name;',
  ].join('\n');

  const { found } = offendersIn(sample);
  const flagged = found.map((f) => f.line);

  if (!flagged.includes(1)) broken.push('a literal `...req.body` spread is no longer flagged');
  if (!flagged.includes(2)) broken.push('`req.body` passed to setDoc is no longer flagged');
  if (!flagged.includes(3)) broken.push('`req.body` passed to writeSingleton is no longer flagged');
  if (flagged.includes(4)) broken.push('the pattern is flagged inside a comment, so the fix cannot document itself');
  if (flagged.includes(5)) broken.push('a write of an already-parsed value is flagged');
  if (flagged.includes(6)) broken.push('reading one field off the body is flagged — that is the fix, not the defect');
}
if (RULES.length === 0) broken.push('the rule list is empty, so this enforces nothing');

const MIN_LINES = 3000;
if (linesScanned < MIN_LINES) {
  console.error(
    `check-no-mass-assignment: only ${linesScanned} lines scanned across ${files.length} file(s), ` +
      `expected at least ${MIN_LINES}. The walk is not reaching the server.`
  );
  process.exit(1);
}
if (broken.length > 0) {
  console.error('check-no-mass-assignment: the scanner is broken —');
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
    `\n${offenders.length} site(s) persist a request body nobody validated. Add a schema to ` +
      'server/domain/apiContracts.ts and write the PARSED value — validating and then storing ' +
      'req.body validates nothing, because the unvalidated bytes are still what get written.'
  );
  process.exit(1);
}

console.log(
  `check-no-mass-assignment: ok (${files.length} files, ${linesScanned} lines, ` +
    `${RULES.length} rules).`
);
