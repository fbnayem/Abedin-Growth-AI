#!/usr/bin/env node
/**
 * Fail if a check has been written so that it cannot fail.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/readiness.sh` — deleted by the commit that adds this — did two things:
 *
 *     npm audit --audit-level=high || echo "⚠️ Ignoring vulnerabilities for now"
 *
 *     if [ ! -f "docs/BACKUP_RESTORE.md" ]; then
 *       mkdir -p docs
 *       echo "# Backup & Restore Process..." > docs/BACKUP_RESTORE.md
 *     fi
 *     echo "✅ Backup procedure documented."
 *
 * The first swallows a failing gate and prints a tick beside it. The second CREATES the
 * document whose presence it is testing, then reports it as present. The script ended with
 * "All checks passed! Ready for production deployment." and `docs/BACKUP_RESTORE.md` was not on
 * disk, which proves it had never completed a run.
 *
 * Both are the same move: a step that reports success without establishing anything. It is the
 * subject of the whole addendum, and it is one line to reintroduce, so the check is on the line
 * rather than on anyone remembering.
 *
 * WHAT IT ENFORCES
 * ----------------
 *   SWALLOWED_FAILURE   `|| true`, `|| :`, `|| echo …` after a command. The exit code is
 *                       discarded and a message is printed in its place.
 *   CONTINUE_ON_ERROR   `continue-on-error: true` in a workflow — the same thing, spelled in
 *                       YAML, and invisible in the log because the step still shows green.
 *   ERRORS_OFF          `set +e` in a shell script, which turns every subsequent failure into a
 *                       warning at a distance from the command that failed.
 *   SUCCESS_FROM_CATCH  `process.exit(0)` inside a catch block. The check threw and reported
 *                       success.
 *
 * WHAT IT DELIBERATELY DOES NOT TRY TO DETECT
 * -------------------------------------------
 * The fabricate-then-assert pattern in general. "Wrote a file, then claimed it existed" needs
 * to relate two statements to each other and to know that one is the subject of the other;
 * every cheap approximation either misses the real case or fires on legitimate setup code. A
 * guardrail that fires on legitimate code gets an exception added to it, and a guardrail full
 * of exceptions is the thing it was written to prevent. The narrow rules above are the ones
 * that can be enforced without lying about their coverage — recorded here so the gap is a known
 * one rather than an assumed absence.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['scripts', '.github'];
const EXTENSIONS = ['.sh', '.mjs', '.cjs', '.ts', '.yml', '.yaml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'build']);

/** This file. It contains every pattern it looks for, in the prose explaining them. */
const SELF = 'scripts/check-gates-can-fail.mjs';

const RULES = [
  {
    id: 'SWALLOWED_FAILURE',
    pattern: /\|\|\s*(true\b|:\s*$|:\s|echo\b)/,
    say: 'the exit code is discarded — this step reports success whatever the command did',
  },
  {
    id: 'CONTINUE_ON_ERROR',
    pattern: /continue-on-error:\s*true/,
    say: 'the step still shows green when it fails, so nothing in the log says the gate did not hold',
  },
  {
    id: 'ERRORS_OFF',
    pattern: /^\s*set\s+\+e\s*$/,
    say: 'every failure after this line becomes a warning, at a distance from the command that failed',
  },
];

/** Comments only. A rule spelled inside a string is still a rule that runs. */
function stripComments(source, isYaml) {
  if (isYaml) {
    // YAML has only line comments, and `#` inside a quoted string is rare enough in a workflow
    // that stripping from an unquoted `#` is safe here.
    return source.replace(/^\s*#[^\n]*$/gm, (m) => ' '.repeat(m.length));
  }
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*(?:\/\/|#)[^\n]*$/gm, (m) => ' '.repeat(m.length))
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
try {
  if (statSync('package.json').isFile()) files.push('package.json');
} catch {
  // Optional.
}

const offenders = [];

for (const path of files) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (rel === SELF) continue;
  const isYaml = rel.endsWith('.yml') || rel.endsWith('.yaml');
  const code = stripComments(readFileSync(path, 'utf8'), isYaml);
  const lines = code.split('\n');

  for (const rule of RULES) {
    lines.forEach((line, i) => {
      if (rule.pattern.test(line)) {
        offenders.push({ rel, line: i + 1, rule: rule.id, say: rule.say, text: line.trim().slice(0, 110) });
      }
    });
  }

  // SUCCESS_FROM_CATCH needs a little structure rather than one line: a `process.exit(0)`
  // anywhere inside a catch block. Scanned by brace depth from each `catch`, which is enough
  // for the shapes that occur here and is documented as such rather than claimed as general.
  if (!isYaml) {
    const catchAt = [...code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)];
    for (const m of catchAt) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const body = code.slice(m.index, i);
      if (/process\.exit\(\s*0\s*\)/.test(body)) {
        offenders.push({
          rel,
          line: code.slice(0, m.index).split('\n').length,
          rule: 'SUCCESS_FROM_CATCH',
          say: 'the check threw and then reported success',
          text: 'catch { … process.exit(0) … }',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Self-check. Each rule is run against text it MUST flag and text it must NOT.
// ---------------------------------------------------------------------------
const MUST_FLAG = [
  ['SWALLOWED_FAILURE', 'npm audit --audit-level=high || echo "Ignoring vulnerabilities for now"'],
  ['SWALLOWED_FAILURE', 'node scripts/check-thing.mjs || true'],
  ['CONTINUE_ON_ERROR', '        continue-on-error: true'],
  ['ERRORS_OFF', '  set +e'],
];
const MUST_NOT_FLAG = [
  ['SWALLOWED_FAILURE', 'const value = a || b;'],
  ['SWALLOWED_FAILURE', "const name = process.env.NAME || 'default';"],
  ['CONTINUE_ON_ERROR', '        continue-on-error: false'],
];

const broken = [];
for (const [id, sample] of MUST_FLAG) {
  const rule = RULES.find((r) => r.id === id);
  if (!rule || !rule.pattern.test(sample)) broken.push(`${id} did not flag: ${sample}`);
}
for (const [id, sample] of MUST_NOT_FLAG) {
  const rule = RULES.find((r) => r.id === id);
  if (rule && rule.pattern.test(sample)) broken.push(`${id} wrongly flagged: ${sample}`);
}
if (RULES.length === 0) broken.push('the rule list is empty, so this check enforces nothing');

const MIN_FILES = 15;
if (files.length < MIN_FILES) {
  console.error(
    `check-gates-can-fail: only ${files.length} files scanned, expected at least ${MIN_FILES}. ` +
      'The walk is not reaching scripts/ or .github/, so a pass here means nothing.'
  );
  process.exit(1);
}
if (broken.length > 0) {
  console.error('check-gates-can-fail: the scanner is broken —');
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
    `\n${offenders.length} check(s) cannot fail. A gate that cannot fail is worse than no gate, ` +
      'because it is mistaken for coverage — which is exactly what scripts/readiness.sh was, ' +
      'right up to the line reading "All checks passed! Ready for production deployment."'
  );
  process.exit(1);
}

console.log(
  `check-gates-can-fail: ok (${files.length} files, ${RULES.length + 1} rules; the ` +
    'fabricate-then-assert pattern is NOT detected — see the header).'
);
