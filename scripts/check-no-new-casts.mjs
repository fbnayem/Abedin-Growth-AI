#!/usr/bin/env node
/**
 * A ratchet on `as any` in live code.
 *
 * WHY
 * ---
 * Every `as any` is a place the compiler was told to stop checking, and this repository has a
 * record of what that costs. `(identity as any).matchedLeadId` read a database key as a customer's
 * name and interpolated it into a prompt. `{} as any` passed two placeholder arguments into the
 * next-best-action call, so `purchaseReadiness.score >= 85` compared `undefined` and every reply
 * took the same branch. `composeAutonomousSalesReply({...} as any)` passed four of six fields under
 * names the function does not read, so `input.identity` was `undefined` at runtime. In each case
 * the cast is the reason nothing said so.
 *
 * WHAT IT COUNTS, AND WHY THE FIRST COUNT WAS WRONG
 * ------------------------------------------------
 * Comments and string bodies are blanked before counting. A naive `grep -c "as any"` over live code
 * reported 67; the real number was 40. The difference was comments — the ones this codebase writes
 * to record a defect it has already fixed, quoting the cast that caused it. A rule that counts
 * those punishes the explanation and teaches people to delete it.
 *
 * The count may FALL, never RISE. Lower BASELINE in the same commit that removes one: a baseline
 * that no longer matches reality is a ratchet that has stopped ratcheting, and this repository has
 * already shipped one of those.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Lower this when you remove one. Do not raise it. */
const BASELINE = 15;

const ROOTS = ['server', 'src', 'shared'];
const FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests']);
const EXTENSIONS = ['.ts', '.tsx'];
const MIN_FILES = 50;

const BS = String.fromCharCode(92);

/**
 * Blank comments and string bodies, preserving offsets and line numbers.
 *
 * The same routine `check-prompt-authority` uses, and for the same reason: a file that merely
 * NAMES the thing being counted is not an instance of it.
 */
function stripCommentsAndStrings(source) {
  const out = source.split('');
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === BS) { j += 2; continue; }
        if (source[j] === ch) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

const CAST = /\bas\s+any\b/g;

function castsIn(source) {
  const code = stripCommentsAndStrings(source);
  const lines = code.split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    CAST.lastIndex = 0;
    let match;
    while ((match = CAST.exec(line)) !== null) hits.push(index + 1);
  });
  return hits;
}

// SELF-CHECK. The rule runs against sources whose answer is known, so a change that blinds it fails
// here rather than reporting a clean tree. The third row is the one that made the first count wrong.
const SELF_CHECK = [
  ['const x = y as any;', 1],
  ['const x = y as any; const z = w as any;', 2],
  ['// this was `(identity as any).matchedLeadId`, which is a contact id', 0],
  ['/* const x = y as any; */', 0],
  ["const message = 'passing {} as any here was the defect';", 0],
  ['const x = y as unknown as Foo;', 0],
  ['const x = y as anyThing;', 0],
];
for (const [source, expected] of SELF_CHECK) {
  const found = castsIn(source).length;
  if (found !== expected) {
    console.error(
      `check-no-new-casts SELF-CHECK FAILED: ${JSON.stringify(source)} gave ${found}, expected ` +
        `${expected}. The rule is broken, not the tree clean.`
    );
    process.exit(1);
  }
}

let filesScanned = 0;
const offenders = [];

function scan(path) {
  filesScanned++;
  for (const line of castsIn(readFileSync(path, 'utf8'))) {
    offenders.push(`${relative(process.cwd(), path).replace(/\\/g, '/')}:${line}`);
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (EXTENSIONS.some((e) => entry.name.endsWith(e))) {
      scan(join(dir, entry.name));
    }
  }
}

for (const root of ROOTS) {
  try {
    if (statSync(root).isDirectory()) walk(root);
  } catch {
    // A root that is not present is not a clean tree; the floor below catches it.
  }
}
for (const file of FILES) {
  try {
    scan(file);
  } catch {
    // Same.
  }
}

if (filesScanned < MIN_FILES) {
  console.error(
    `check-no-new-casts: only ${filesScanned} files scanned (floor ${MIN_FILES}). The scan is ` +
      'broken, not the tree clean.'
  );
  process.exit(1);
}

const count = offenders.length;

if (count > BASELINE) {
  console.error(
    `check-no-new-casts: ${count} \`as any\` casts in live code, baseline ${BASELINE}.\n` +
      'A cast is a place the compiler was told to stop checking. If the type is genuinely unknown,\n' +
      'narrow it (`typeof x === "string" ? x : null`) rather than asserting it.\n'
  );
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}

if (count < BASELINE) {
  console.error(
    `check-no-new-casts: ${count} casts remain, baseline ${BASELINE}. Progress — lower BASELINE in\n` +
      'scripts/check-no-new-casts.mjs to ' + count + ' in this commit, so it cannot go back up.'
  );
  process.exit(1);
}

console.log(
  `check-no-new-casts: ok — ${count} \`as any\` casts (baseline ${BASELINE}); none added. ` +
    `${filesScanned} files scanned.`
);
