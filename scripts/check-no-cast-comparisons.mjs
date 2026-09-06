#!/usr/bin/env node
/**
 * Guardrail — a comparison operand must not be cast to `any`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The inbound pipeline's only "do not reply" guard read:
 *
 *     if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any) {
 *        return;
 *     }
 *
 * Neither literal is a member of `NextBestActionType`. Without the casts TypeScript reports
 * "This comparison appears to be unintentional because the types have no overlap" — which is
 * exactly the defect, stated by the compiler. The casts silenced it, so the guard was dead.
 *
 * Measured by running the decision engine over real inbound text:
 *
 *     unsubscribe request      action=SUPPRESS   guard fires? NO
 *     out-of-office reply      action=NO_REPLY   guard fires? NO
 *
 * A prospect who asked to be removed from the list was drafted a sales reply, and an
 * autoresponder was answered as though a person had written it. The one branch that suppresses
 * could never run, so the pipeline's effective default was always to send (§14, inverted).
 *
 * WHAT THIS CATCHES THAT THE OTHER CAST GUARDRAIL DOES NOT
 * -------------------------------------------------------
 * `check-no-cast-call-arguments` forbids an object literal cast to `any` in ARGUMENT position.
 * It does not see `'STRING' as any` in a comparison, because there is no object literal and no
 * call. Both are the same mistake in different grammar: a cast placed exactly where the
 * compiler was about to prove something, so that it proves nothing instead.
 *
 * A comparison is the one place where `as any` cannot be "narrowing a value of genuinely
 * unknown type" — the whole point of `===` is that the two sides are comparable, and if they
 * are not, that IS the answer. Hence no allow-list entries; if a real one appears, add it with
 * the argument for it.
 *
 * Exit 1 on a violation. Baseline: zero.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SCAN_ROOTS = ['server', 'src', 'shared'];
const SCAN_FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests']);

/** Files permitted to do this, each with the reason somebody argued for. */
const ALLOWED = new Map();

/**
 * A comparison operator, then an operand within the same parenthesised expression that ends in
 * `as any`. `[^;{}()]` keeps the match inside one expression so a cast on a LATER line cannot
 * be attributed to an earlier comparison.
 */
const CAST_AFTER_COMPARISON = /(?:===|!==|==(?!=)|!=(?!=))\s*[^;{}()]{0,120}?\bas\s+any\b/g;

/** ...and the mirror image: `x as any === y`. */
const CAST_BEFORE_COMPARISON = /\bas\s+any\b\s*(?:===|!==|==(?!=)|!=(?!=))/g;

/**
 * The parenthesised left operand: `(foo as any) === bar`.
 *
 * The lookbehind is what keeps this from firing on `f(bar as any) === baz`, where the cast is
 * an ARGUMENT and the comparison's left side is the call's properly-typed return value. A `(`
 * preceded by an identifier character opens a call, not a grouping.
 */
const PARENTHESISED_CAST_BEFORE_COMPARISON =
  /(?<![A-Za-z0-9_$\]])\(\s*[^;{}()]{0,120}?\bas\s+any\s*\)\s*(?:===|!==|==(?!=)|!=(?!=))/g;

const PATTERNS = [
  CAST_AFTER_COMPARISON,
  CAST_BEFORE_COMPARISON,
  PARENTHESISED_CAST_BEFORE_COMPARISON,
];

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
      // The QUOTES are kept and only the contents blanked, so `x === '...' as any` still reads
      // as a comparison against a literal. Blanking the quotes too would hide the violation.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function hits(source) {
  const code = stripCommentsAndStrings(source);
  let total = 0;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    total += (code.match(pattern) || []).length;
  }
  return total;
}

const violations = [];

// ---------------------------------------------------------------- self-check
/**
 * A scanner that matches nothing reports "ok". Six guardrails on this branch have been caught
 * able to degrade into a silent no-op, so this one proves it still recognises its own subject
 * before it judges anything.
 */
const MUST_MATCH = [
  // The original defect, verbatim.
  "if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any) {",
  'if (x !== y as any) {}',
  'if ((foo as any) === bar) {}',
  'const same = a as any === b;',
  'if (status == "DONE" as any) {}',
];
const MUST_NOT_MATCH = [
  'const x = { a: 1 } as any;', // a declaration
  'f(bar as any)', // an argument
  'const y = (foo as any).bar;', // a property access, no comparison
  "if (a === 'DO_NOTHING') {}", // the correct form
  'if (a === b) { const c = d as any; }', // a cast in a LATER statement
  'if (a === b) {}\nconst z = q as any;', // ...and on a later line
  "// if (a === 'X' as any) {}", // a comment
  "const s = \"a === 'X' as any\";", // a string
  'if (a === b as SomeType) {}', // a real type, which the compiler still checks
  // The cast is an ARGUMENT; the comparison's left side is the call's real return type.
  'if (f(bar as any) === baz) {}',
  'if (obj.method(x as any) !== y) {}',
];

// The self-check needs a self-check: emptying these two arrays disables every assertion below
// while leaving the scan intact, and the run still reported "ok". Found by mutating this file.
if (MUST_MATCH.length === 0 || MUST_NOT_MATCH.length === 0) {
  violations.push({
    file: '(self-check)',
    line: 0,
    message:
      'the self-check sample sets are empty, so the scanner proves nothing about itself ' +
      `before judging the tree (MUST_MATCH=${MUST_MATCH.length}, MUST_NOT_MATCH=${MUST_NOT_MATCH.length}).`,
  });
}

for (const sample of MUST_MATCH) {
  if (hits(sample) === 0) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message: `the scanner no longer recognises a form it exists to catch:\n      ${sample}`,
    });
  }
}
for (const sample of MUST_NOT_MATCH) {
  if (hits(sample) > 0) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message: `the scanner flags a legitimate form:\n      ${sample.replace(/\n/g, ' ')}`,
    });
  }
}

// ---------------------------------------------------------------- scan
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

const files = [];
// Each root is walked separately and its yield checked, rather than trusting one total. With a
// single total, emptying SCAN_ROOTS still left `server.ts` from SCAN_FILES, so `scanned` was 1
// and every "did we scan anything" check passed while the scanner covered one file out of 146.
// Found by mutating this file.
for (const root of SCAN_ROOTS) {
  const before = files.length;
  walk(join(ROOT, root), files);
  if (files.length === before) {
    violations.push({
      file: '(scan)',
      line: 0,
      message: `scan root '${root}' yielded no files — it was removed, renamed, or the walker is broken.`,
    });
  }
}
if (SCAN_ROOTS.length === 0) {
  violations.push({ file: '(scan)', line: 0, message: 'SCAN_ROOTS is empty; nothing is covered.' });
}
for (const file of SCAN_FILES) files.push(join(ROOT, file));

let scanned = 0;
let examined = 0;
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
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code)) !== null) {
      const line = code.slice(0, match.index).split('\n').length;
      violations.push({
        file: rel,
        line,
        message:
          'a comparison operand is cast to `any`.\n' +
          '      Without the cast the compiler decides whether these two values can ever be ' +
          'equal, and if they cannot, saying so IS the answer. See the dead suppression guard ' +
          'in server/services/inboundPipeline.ts, where two casts hid a comparison against ' +
          'strings that are not members of the union — so a customer who asked to unsubscribe ' +
          'was sent a sales reply.',
      });
    }
  }
}

if (scanned === 0) {
  violations.push({ file: '(scan)', line: 0, message: 'scanned no files — the walker is broken' });
}
if (examined < scanned - ALLOWED.size) {
  violations.push({
    file: '(scan)',
    line: 0,
    message: `only ${examined} of ${scanned} files reached the pattern; the scanner is skipping files.`,
  });
}

if (violations.length > 0) {
  console.error(`check-no-cast-comparisons: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n      ${v.message}\n`);
  process.exit(1);
}

console.log(`check-no-cast-comparisons: ok (${examined} files checked, baseline zero)`);
