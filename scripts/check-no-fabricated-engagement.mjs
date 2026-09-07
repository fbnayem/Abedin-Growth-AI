#!/usr/bin/env node
/**
 * Fail if an engagement or deliverability figure is manufactured rather than measured.
 *
 * WHY THIS EXISTS
 * ---------------
 * Four separate sources, all rendered as fact:
 *
 *   - `seedLeadsGenerator.ts` computed engagement from the LOOP INDEX —
 *     `i % 5 === 0 ? "CLICKED" : i % 3 === 0 ? "OPENED" : "DELIVERED"` — plus
 *     `spamScore: 0.0`, `qcScore: 97 + (i % 3)` and `deliverabilityStatus: "VERIFIED_CLEAN"`.
 *     Those records are persisted to `data_storage.json` and reloaded, so they read as recorded
 *     history rather than as fixtures.
 *   - `server.ts` invented `enrolledCount * 0.68` engagement and `* 0.12` conversion at campaign
 *     creation and persisted them.
 *   - `CampaignsView.tsx` built a 30-day series from `Math.sin`, `Math.cos` and `Math.random`
 *     under a comment reading "Add realistic-looking sinusoidal noise", rendered as a
 *     "30-Day Performance Trend".
 *   - Hardcoded JSX asserting `Spam Score: 0.0 • 100% Clean Deliverability` and
 *     `SPF, DKIM, DMARC Verified`.
 *
 * There is no open pixel, no click redirect and no bounce or complaint webhook anywhere in this
 * system, and it has never sent an autonomous email. Nothing could have observed any of it.
 *
 * S27's worst case is a founder scaling spend on `enrolledCount * 0.68` and reporting it to an
 * investor while the domain has no DKIM record. A chart is the worst form of it, because it
 * asserts a shape over time — which is the thing a person extrapolates from.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   RANDOM_METRIC        `Math.random`, `Math.sin` or `Math.cos` in a file that also names an
 *                        engagement field. Randomness elsewhere is fine; randomness beside
 *                        `engagement` is a fabricated series.
 *   INDEX_DERIVED_STATE  `i % n` producing OPENED / CLICKED / DELIVERED / REPLIED.
 *   ASSERTED_CLEAN       a literal claiming verified deliverability — `VERIFIED_CLEAN`,
 *                        `spamScore: 0`, `SPF, DKIM, DMARC Verified`, `100% Clean`.
 *
 * WHAT IT DOES NOT CLAIM
 * ----------------------
 * It cannot tell a real measurement from a plausible constant that arrived some other way. It
 * catches the three spellings these four sources actually used. A fifth source inventing a
 * number by a route not listed here would pass, and that is stated rather than implied away.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server', 'src', 'shared'];
const FILES = ['server.ts'];
const EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

/** This file. It quotes every pattern it looks for. */
const SELF = 'scripts/check-no-fabricated-engagement.mjs';

/** Words that mean "somebody engaged with a message we sent". */
const ENGAGEMENT = /\b(openCount|openedCount|clickedAt|clickCount|engagement|deliverabilityStatus|spamScore|bounceRate)\b/;

const RULES = [
  {
    id: 'RANDOM_METRIC',
    // Only meaningful in a file that also talks about engagement; randomness on its own is fine.
    fileMustMention: ENGAGEMENT,
    test: (line) => /Math\.(random|sin|cos)\s*\(/.test(line),
    say: 'an engagement figure is generated rather than measured',
  },
  {
    id: 'INDEX_DERIVED_STATE',
    fileMustMention: null,
    test: (line) =>
      /\bi\s*%\s*\d+/.test(line) === false
        ? false
        : /["'](OPENED|CLICKED|DELIVERED|REPLIED)["']/.test(line),
    say: 'a delivery or engagement state is computed from a loop index',
  },
  {
    id: 'ASSERTED_CLEAN',
    fileMustMention: null,
    test: (line) => {
      // A union in a TYPE declaration is a vocabulary, not a claim. `'VERIFIED_CLEAN'` has to be
      // nameable for anything ever to report it; what is forbidden is ASSERTING it.
      if (/^\s*\w+\??:\s*'[^']*'(\s*\|\s*'[^']*')+;?\s*$/.test(line)) return false;
      return /VERIFIED_CLEAN|spamScore:\s*0(\.0+)?\b|SPF,?\s*DKIM,?\s*(and\s*)?DMARC\s*Verified|100%\s*Clean/.test(
        line
      );
    },
    say: 'deliverability is asserted as verified by a literal, with nothing having checked it',
  },
];

/** Comments only. Every one of these files documents the pattern it replaced. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*(?:\/\/|\*)[^\n]*$/gm, (m) => ' '.repeat(m.length))
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

/** Offenders in one source, through the same code the scan uses. */
function offendersIn(source) {
  const code = stripComments(source);
  const lines = code.split('\n');
  const found = [];
  for (const rule of RULES) {
    if (rule.fileMustMention && !rule.fileMustMention.test(code)) continue;
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
  if (rel === SELF) continue;
  const { found, lines } = offendersIn(readFileSync(path, 'utf8'));
  linesScanned += lines;
  for (const o of found) offenders.push({ rel, ...o });
}

// ---------------------------------------------------------------------------
// Self-check, through offendersIn rather than a copy of its rules.
// ---------------------------------------------------------------------------
const broken = [];
{
  const sample = [
    'const engagement = Math.floor(base + Math.sin(i) * 3);',
    'const s = i % 3 === 0 ? "OPENED" : "DELIVERED";',
    'deliverabilityStatus: "VERIFIED_CLEAN",',
    'spamScore: 0.0,',
    '// Math.random() in a comment explaining the fix',
    'const jitter = Math.random();',
    'const openCount = row.openCount;',
  ].join('\n');

  const flagged = offendersIn(sample).found.map((f) => f.line);
  if (!flagged.includes(1)) broken.push('a generated engagement figure is no longer flagged');
  if (!flagged.includes(2)) broken.push('an index-derived delivery state is no longer flagged');
  if (!flagged.includes(3)) broken.push('VERIFIED_CLEAN is no longer flagged');
  if (!flagged.includes(4)) broken.push('an asserted spamScore of zero is no longer flagged');
  if (flagged.includes(5)) broken.push('the pattern is flagged in a comment, so the fix cannot document itself');
  if (!flagged.includes(6)) {
    broken.push('randomness in an engagement file is no longer flagged (line 6 shares the file)');
  }
  if (flagged.includes(7)) broken.push('reading a stored openCount is flagged — that is a read, not a fabrication');
}
if (RULES.length === 0) broken.push('the rule list is empty, so this enforces nothing');

const MIN_FILES = 80;
if (files.length < MIN_FILES) {
  console.error(
    `check-no-fabricated-engagement: only ${files.length} files scanned, expected at least ` +
      `${MIN_FILES}. The walk is not reaching the source tree.`
  );
  process.exit(1);
}
if (broken.length > 0) {
  console.error('check-no-fabricated-engagement: the scanner is broken —');
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
    `\n${offenders.length} manufactured engagement or deliverability figure(s). Nothing in this ` +
      'system observes an open, a click, a bounce or a complaint, so there is no number to ' +
      'report — and an absent field is the accurate answer, where a zero renders as a measurement.'
  );
  process.exit(1);
}

console.log(
  `check-no-fabricated-engagement: ok (${files.length} files, ${linesScanned} lines, ` +
    `${RULES.length} rules; a fifth invention route would pass — see the header).`
);
