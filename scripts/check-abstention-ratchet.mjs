#!/usr/bin/env node
/**
 * S23 — a ratchet on the call sites that cannot tell an answer from a substitute.
 *
 * WHY
 * ---
 * `safeGenerateJSON(options)` returns `T` whether a model answered or all five candidates
 * failed. The caller receives a well-formed object of exactly the expected shape and has no way
 * to branch on which happened. That is the shape §23 objects to, and it is why the live reply
 * composer could fall through to a hand-written email during a model outage without anything
 * downstream noticing.
 *
 * `generateJsonOrAbstain(options)` returns `ModelOutcome<T>` — a discriminated union the
 * compiler will not let a caller read past without checking. Every call site should end up
 * there.
 *
 * Converting all of them in one commit would mix a mechanical refactor into a safety fix, so
 * the legacy wrapper stays and this holds the line: the count may FALL, never RISE. A ratchet
 * makes "we will migrate the rest later" an enforceable statement instead of an intention.
 *
 * WHEN YOU CONVERT ONE
 * --------------------
 * Lower BASELINE in the same commit. The check fails if the count drops below it, too — not
 * because a lower count is bad, but because a baseline that no longer matches reality is a
 * ratchet that has stopped ratcheting, and this repository has already shipped one of those.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every call site of the legacy wrapper, outside its own module and outside tests.
 *
 * Lower this when you convert one. Do not raise it.
 */
const BASELINE = 11;

const SCAN_ROOTS = ['server', 'src', 'shared'];
const SCAN_FILES = ['server.ts'];
const EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);
/** The wrapper's own module defines and documents it; counting that would be counting itself. */
const SKIP_FILES = new Set(['server/geminiClient.ts', 'server/domain/abstention.ts']);

/**
 * Comments and strings are removed before counting.
 *
 * Every one of this repository's scanners learned this the same way: the previous
 * prompt-authority check counted its own explanatory comments and reported offenders that were
 * prose. A doc-comment naming the function must not consume the budget.
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const c = source[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Every mention of the identifier, minus the import that brought it in.
 *
 * The first version of this matched `safeGenerateJSON\s*(?:<[^;{}()]*>)?\s*\(` — the call, with
 * an optional type argument. It reported **6 call sites where grep found 14**, and the reason is
 * instructive: the character class excludes `{`, `}` and `;`, so every call written as
 *
 *     await safeGenerateJSON<{ subject: string; body: string }>({ ... })
 *
 * — an inline object type, which is most of them — failed to match. A ratchet that silently
 * counts less than half of what it is guarding is worse than none, because the number it prints
 * is mistaken for coverage. Matching the bare identifier cannot have that failure mode: there is
 * nothing to get wrong about the shape of a call.
 */
const IDENTIFIER = /\bsafeGenerateJSON\b/g;

const sites = [];
let filesScanned = 0;

function isImportLine(line) {
  return /^\s*(import|export)\b/.test(line);
}

function check(path) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (SKIP_FILES.has(rel)) return;
  filesScanned++;
  const code = stripCommentsAndStrings(readFileSync(path, 'utf8'));
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    IDENTIFIER.lastIndex = 0;
    if (!IDENTIFIER.test(lines[i])) continue;
    // An import is how a call site reaches the function; it is not itself one, and counting it
    // would make the number depend on how many files import rather than how many call.
    if (isImportLine(lines[i])) continue;
    sites.push(`${rel}:${i + 1}`);
  }
}

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
      check(join(dir, entry.name));
    }
  }
}

// ---------------------------------------------------------------------------
// Self-check, before the scan. A scanner that matches nothing reports success.
// ---------------------------------------------------------------------------
const MUST_MATCH = [
  'const x = await safeGenerateJSON({ fallbackData: {} });',
  'const x = await safeGenerateJSON<Foo>({ fallbackData: {} });',
  // The shape the first version of this scanner missed. Keep it first in spirit: it is the
  // reason the detection is an identifier match rather than a call-shape match.
  'const x = await safeGenerateJSON<{ subject: string; body: string }>({});',
  '  const data = await safeGenerateJSON<{',
  'safeGenerateJSON({});',
];
const MUST_NOT_MATCH = [
  '// safeGenerateJSON is the legacy form',
  '/* do not use safeGenerateJSON here */',
  "const name = 'safeGenerateJSON';",
  'const x = await generateJsonOrAbstain({});',
  'const y = mySafeGenerateJSONWrapper({});',
];
/** Lines that mention it but are not call sites. */
const MUST_BE_SKIPPED_AS_IMPORT = [
  'import { safeGenerateJSON } from "../geminiClient";',
  'export { safeGenerateJSON };',
];

const selfFailures = [];
for (const src of MUST_MATCH) {
  IDENTIFIER.lastIndex = 0;
  if (!IDENTIFIER.test(stripCommentsAndStrings(src))) selfFailures.push('did NOT match: ' + src);
}
for (const src of MUST_NOT_MATCH) {
  IDENTIFIER.lastIndex = 0;
  if (IDENTIFIER.test(stripCommentsAndStrings(src))) selfFailures.push('wrongly matched: ' + src);
}
for (const src of MUST_BE_SKIPPED_AS_IMPORT) {
  if (!isImportLine(src)) selfFailures.push('not recognised as an import line: ' + src);
}
if (MUST_MATCH.length < 5 || MUST_NOT_MATCH.length < 5 || MUST_BE_SKIPPED_AS_IMPORT.length < 2) {
  selfFailures.push('the self-check case lists have been emptied, so the self-check proves nothing');
}
if (selfFailures.length > 0) {
  console.error('check-abstention-ratchet: THE CHECK ITSELF IS BROKEN.');
  for (const f of selfFailures) console.error('  - ' + f);
  process.exit(1);
}

for (const root of SCAN_ROOTS) walk(root);
for (const file of SCAN_FILES) {
  try {
    if (statSync(file).isFile()) check(file);
  } catch {
    // Optional file.
  }
}

if (filesScanned < 50) {
  console.error(
    `check-abstention-ratchet: only ${filesScanned} files were scanned, which is too few to be ` +
      'a real scan of this repository. The roots or the extension list are wrong.'
  );
  process.exit(1);
}

if (sites.length > BASELINE) {
  console.error(
    `check-abstention-ratchet: ${sites.length} call sites of safeGenerateJSON, baseline ${BASELINE}.`
  );
  console.error(
    '  A caller of safeGenerateJSON cannot tell a model answer from `fallbackData` (S23). Use'
  );
  console.error('  generateJsonOrAbstain and handle the abstention.');
  for (const s of sites) console.error('   - ' + s);
  process.exit(1);
}

if (sites.length < BASELINE) {
  console.error(
    `check-abstention-ratchet: ${sites.length} call sites, but BASELINE is ${BASELINE}. Lower ` +
      'BASELINE in this commit. A baseline that no longer matches reality is a ratchet that has ' +
      'stopped ratcheting, and this repository has already shipped one of those.'
  );
  process.exit(1);
}

console.log(
  `check-abstention-ratchet: ok — ${sites.length} legacy safeGenerateJSON call site(s) ` +
    `(baseline ${BASELINE}); none added. ${filesScanned} files scanned.`
);
