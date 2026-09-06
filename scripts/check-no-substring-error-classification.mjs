#!/usr/bin/env node
/**
 * P1.11 guardrail — no decision about a provider failure may be made by reading its prose.
 *
 * WHY THIS EXISTS
 * ---------------
 * The gateway decided the §32 question — "might the provider have done it anyway?" — with:
 *
 *     const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');
 *
 * It was wrong in both directions, measurably:
 *
 *   - `fetchWithTimeout` throws `HttpTimeoutError`, message "…timed out after 15000ms".
 *     "timed out" does not contain "timeout", so the only timeout this codebase raises was
 *     classified as a DEFINITE failure — and became eligible for retry. A send that may have
 *     been delivered got sent again.
 *   - Provider errors quote request content, so a customer writing "timeout" in a subject line
 *     could flip the classification the other way (§18).
 *
 * THE RULE
 * --------
 * Classification reads the error's type, its `code`/`cause.code`, or an HTTP status. Never
 * `.message`. This script fails if any comparison-shaped read of an error message reappears.
 *
 * Exit 1 on a violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = ['server', 'shared'];
const SCAN_FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests']);

/**
 * Reading `err.message` to LOG it is fine and useful. What is forbidden is reading it to make a
 * decision — a comparison, a match, or a membership test.
 */
const FORBIDDEN = [
  {
    // e.message.includes(...) / err.message?.includes(...) / error.message.match(...)
    pattern: /\b(?:e|err|error|ex|cause)\d?\??\.message\s*\??\.\s*(includes|match|startsWith|endsWith|search|indexOf|test)\s*\(/g,
    label: 'decides on the text of an error message',
  },
  {
    // A regex or string tested AGAINST an error message: /timeout/.test(e.message)
    pattern: /\.test\(\s*(?:e|err|error|ex|cause)\d?\??\.message\b/g,
    label: 'tests a pattern against an error message',
  },
  {
    // String(e).includes(...) — the same decision wearing a cast.
    pattern: /String\(\s*(?:e|err|error|ex|cause)\d?\s*\)\s*\.\s*(includes|match|startsWith|endsWith|indexOf)\s*\(/g,
    label: 'decides on an error stringified to text',
  },
];

const ALLOWED = new Map([
  [
    'server/services/gmailHistorySync.service.ts',
    'Gmail returns no machine-readable marker for "historyId is out of date" — the 404 it pairs ' +
      'with is ambiguous between that and a deleted mailbox. The read is bounded to recovering a ' +
      'sync cursor, it gates no external side effect, and the failure mode of getting it wrong is ' +
      'a full resync rather than a duplicate send. Revisit if Google ever ships a reason code.',
  ],
]);

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
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
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

function walk(dir, acc) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

const violations = [];

// ---------------------------------------------------------------- self-check
/**
 * The failure mode that has hit this branch four times: a scanner that matches nothing reports
 * "ok". Before judging the repository, the script proves it still recognises the exact line it
 * was written to forbid, and still ignores the things that are fine.
 */
const MUST_MATCH = [
  "const isAmbiguous = e.message.includes('timeout') || e.message.includes('network');",
  "if (err.message?.match(/rate/)) { retry(); }",
  "if (String(error).includes('ECONNRESET')) {}",
  "if (/timeout/.test(e.message)) {}",
];
const MUST_NOT_MATCH = [
  'console.error("failed", e.message);',
  'return { success: false, error: e.message };',
  "if (e instanceof HttpTimeoutError) {}",
  "if (e.code === 'ECONNRESET') {}",
  'if (response.status === 429) {}',
];

function hits(source) {
  const code = stripCommentsAndStrings(source);
  let total = 0;
  for (const { pattern } of FORBIDDEN) {
    pattern.lastIndex = 0;
    total += (code.match(pattern) || []).length;
  }
  return total;
}

for (const sample of MUST_MATCH) {
  if (hits(sample) === 0) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message: `the scanner no longer recognises a forbidden line it exists to catch:\n      ${sample}`,
    });
  }
}
for (const sample of MUST_NOT_MATCH) {
  if (hits(sample) > 0) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message: `the scanner flags a legitimate line, and would flood real code with noise:\n      ${sample}`,
    });
  }
}

// ---------------------------------------------------------------- scan
const files = [];
for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
for (const file of SCAN_FILES) files.push(join(ROOT, file));

let scanned = 0;
let examined = 0; // files actually run through the patterns, after the allow-list
for (const absolute of files) {
  const rel = relative(ROOT, absolute).split(sep).join('/');
  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  if (ALLOWED.has(rel)) continue;
  examined++;
  const code = stripCommentsAndStrings(source);
  for (const { pattern, label } of FORBIDDEN) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const line = code.slice(0, match.index).split('\n').length;
      violations.push({
        file: rel,
        line,
        message:
          `${label}: \`${match[0].trim()}…\`\n` +
          "      An error's prose is not a signal. Classify on the type, on `code`/`cause.code`, " +
          'or on an HTTP status — see server/lib/providerError.ts. If this really is unavoidable, ' +
          'add the file to ALLOWED with the reason and say what it does NOT gate.',
      });
    }
  }
}

if (scanned === 0) {
  violations.push({ file: '(scan)', line: 0, message: 'scanned no files — the walker is broken' });
}
// Counting files READ is not the same as counting files CHECKED. A mutation that made every
// file skip the patterns left `scanned` untouched and still reported "ok" with a plausible
// number beside it — found by mutation-testing this script, not by reading it.
if (examined < scanned - ALLOWED.size) {
  violations.push({
    file: '(scan)',
    line: 0,
    message:
      `only ${examined} of ${scanned} files reached the patterns, with ${ALLOWED.size} ` +
      'documented exception(s). The scanner is skipping files it should be checking.',
  });
}

if (violations.length > 0) {
  console.error(`check-no-substring-error-classification: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n      ${v.message}\n`);
  process.exit(1);
}

console.log(
  `check-no-substring-error-classification: ok (${examined} files checked, ` +
    `${ALLOWED.size} documented exception)`
);
