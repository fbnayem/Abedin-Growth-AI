#!/usr/bin/env node
/**
 * P1.9 guardrail — two rules about time, both of which were broken in ways a clean compile and a
 * passing test suite could not see.
 *
 * RULE 1: every Postgres timestamp column carries a zone.
 *   `timestamp('x')` is `timestamp without time zone`: it keeps the digits and forgets which
 *   zone produced them. All 76 columns in this schema were that. Two servers in different
 *   regions write "14:30" into the same column and mean different moments, and nothing in the
 *   row records which one meant what.
 *
 * RULE 2: no local-zone Date method outside the time module.
 *   `setHours`, `getDay`, `getFullYear` and their siblings read the MACHINE's zone. The reply
 *   composer used `setHours(14, 30)` under a comment reading `// 2:30 PM BST`, and on the
 *   machine this was measured on it produced 09:30 in London. The method is not wrong; the
 *   silence is. Anything that needs a wall clock must name the zone it means.
 *
 * Exit 1 on a violation.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCHEMA = 'server/db/schema.ts';
const TIME_MODULE = 'shared/domain/time.ts';

const SCAN_ROOTS = ['server', 'src', 'shared'];
const SCAN_FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests']);

/**
 * Files permitted to read the machine's local zone, each with the reason it is legitimate.
 * A file gets on this list because somebody argued for it, not because it was failing.
 */
const ALLOWED_LOCAL_ZONE = new Map([
  [
    'src/pages/CampaignsView.tsx',
    'Chart x-axis: walks back 30 calendar days for a graph the browser itself renders. The ' +
      'viewer IS the local zone here, and no instant is stored or sent anywhere.',
  ],
]);

/** The Date methods that silently use the machine's zone. UTC and epoch accessors are fine. */
const LOCAL_ZONE_METHODS = [
  'setHours',
  'setMinutes',
  'setSeconds',
  'setDate',
  'setMonth',
  'setFullYear',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getDay',
  'getDate',
  'getMonth',
  'getFullYear',
  'getTimezoneOffset',
];
const LOCAL_ZONE_PATTERN = new RegExp(`\\.(${LOCAL_ZONE_METHODS.join('|')})\\s*\\(`, 'g');

/**
 * Strip comments and string literals before scanning.
 *
 * This matters more than it looks: the fixes for P1.9 quote the broken lines verbatim in their
 * comments, so a scanner that reads comments would report the explanation of a bug as the bug.
 * Replacing with spaces of equal length keeps line and column numbers truthful.
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
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

const violations = [];

// ---------------------------------------------------------------- self-check
/**
 * A scanner that matches nothing reports "ok". That failure mode has hit three guardrails on
 * this branch — twice a regex that could not cross a nested paren, once a pattern anchored to
 * text that had moved — and each time the script cheerfully passed against the exact code it
 * forbids. So before it judges the repository, it judges itself against samples whose verdicts
 * are known.
 */
const SELF_TEST_MUST_MATCH = 'const d = new Date(); d.setHours(9, 0, 0, 0); d.getDay();';
const SELF_TEST_MUST_NOT_MATCH = [
  'const d = new Date(); d.getUTCHours(); d.getTime();',
  '// d.setHours(9) in a comment',
  "const s = 'd.setHours(9) in a string';",
].join('\n');

function localZoneHits(source) {
  const code = stripCommentsAndStrings(source);
  LOCAL_ZONE_PATTERN.lastIndex = 0;
  return (code.match(LOCAL_ZONE_PATTERN) || []).length;
}

const selfHits = localZoneHits(SELF_TEST_MUST_MATCH);
const selfFalsePositives = localZoneHits(SELF_TEST_MUST_NOT_MATCH);
if (selfHits < 2) {
  violations.push({
    file: '(self-check)',
    line: 0,
    message:
      `rule 2 found ${selfHits} of 2 known violations in its own sample. The scanner has ` +
      'stopped detecting what it exists to detect; an "ok" from it would mean nothing.',
  });
}
if (selfFalsePositives > 0) {
  violations.push({
    file: '(self-check)',
    line: 0,
    message:
      `rule 2 reported ${selfFalsePositives} violation(s) in comments, strings and UTC ` +
      'accessors, which are all legitimate. It would flood real code with noise.',
  });
}

const SCHEMA_COLUMN_PATTERN = /timestamp\('[a-z0-9_]+'/g;
const SCHEMA_ZONED_PATTERN = /timestamp\('[a-z0-9_]+',\s*\{\s*withTimezone:\s*true\s*\}/g;
const SCHEMA_SELF_TEST = "createdAt: timestamp('created_at', { withTimezone: true }), x: timestamp('bare'),";
{
  const seen = (SCHEMA_SELF_TEST.match(SCHEMA_COLUMN_PATTERN) || []).length;
  const zoned = (SCHEMA_SELF_TEST.match(SCHEMA_ZONED_PATTERN) || []).length;
  if (seen !== 2 || zoned !== 1) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message:
        `rule 1 read its own sample as ${seen} column(s), ${zoned} zoned; it should read 2 and 1. ` +
        'The schema patterns no longer describe the schema syntax.',
    });
  }
}

// ---------------------------------------------------------------- RULE 1
let schemaSource;
try {
  schemaSource = readFileSync(join(ROOT, SCHEMA), 'utf8');
} catch {
  schemaSource = null;
}
if (schemaSource === null) {
  violations.push({ file: SCHEMA, line: 0, message: 'schema not found; rule 1 cannot be checked' });
} else {
  const lines = schemaSource.split('\n');
  let columnsSeen = 0;
  lines.forEach((line, index) => {
    // Every `timestamp('col'` occurrence, whatever follows it on the line.
    const matches = line.match(/timestamp\('[a-z0-9_]+'/g);
    if (matches === null) return;
    columnsSeen += matches.length;
    // A zoned column reads `timestamp('col', { withTimezone: true })`.
    const zoned = (line.match(/timestamp\('[a-z0-9_]+',\s*\{\s*withTimezone:\s*true\s*\}/g) || []).length;
    if (zoned < matches.length) {
      violations.push({
        file: SCHEMA,
        line: index + 1,
        message:
          `timestamp column without a zone: ${line.trim()}\n` +
          '      `timestamp(...)` is `timestamp without time zone` — it stores the digits and ' +
          'forgets which zone wrote them. Use `{ withTimezone: true }`.',
      });
    }
  });
  if (columnsSeen === 0) {
    violations.push({
      file: SCHEMA,
      line: 0,
      message: 'found no timestamp columns at all — the rule 1 scanner is no longer matching anything',
    });
  }
}

// ---------------------------------------------------------------- RULE 2
const files = [];
for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
for (const file of SCAN_FILES) files.push(join(ROOT, file));

let scanned = 0;
for (const absolute of files) {
  const rel = relative(ROOT, absolute).split(sep).join('/');
  if (rel === TIME_MODULE) continue; // the module whose job this is
  let source;
  try {
    source = readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  const code = stripCommentsAndStrings(source);
  LOCAL_ZONE_PATTERN.lastIndex = 0;
  let match;
  while ((match = LOCAL_ZONE_PATTERN.exec(code)) !== null) {
    if (ALLOWED_LOCAL_ZONE.has(rel)) continue;
    const line = code.slice(0, match.index).split('\n').length;
    violations.push({
      file: rel,
      line,
      message:
        `\`.${match[1]}()\` reads the machine's local zone.\n` +
        '      Whatever this means, it means something different on a server in another region. ' +
        'Use shared/domain/time.ts and name the zone, or add this file to ALLOWED_LOCAL_ZONE ' +
        'with the reason it is safe.',
    });
  }
}

if (scanned === 0) {
  violations.push({ file: '(scan)', line: 0, message: 'scanned no files — the rule 2 walker is broken' });
}

if (violations.length > 0) {
  console.error(`check-time-correctness: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n      ${v.message}\n`);
  process.exit(1);
}

console.log(`check-time-correctness: ok (${scanned} files scanned, every timestamp column zoned)`);
