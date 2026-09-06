#!/usr/bin/env node
/**
 * Guardrail — an object literal passed to a function must not be cast to `any`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The live inbound drafting path called:
 *
 *     composeAutonomousSalesReply({ incomingEmail: ..., latestIntent: ...,
 *       buyingStage: ..., nextBestAction: ..., prospectName: ... } as any)
 *
 * The function requires `identity`, `emailUnderstanding` and `rawInboundText`. Four of the six
 * fields were passed under names it does not read, and the cast is the only reason that
 * compiled. At runtime `input.identity` was `undefined` and the first unconditional use of it
 * threw `TypeError: Cannot read properties of undefined (reading 'contactId')` — on every
 * inbound email, swallowed by an enclosing `catch (e) { console.error(...) }`. The path had
 * never once produced a draft.
 *
 * Two lines away, the same file did `determineNextBestAction(understanding, stage, {} as any,
 * {} as any)`. That one does not throw — `undefined >= 85` is just `false` — so two decision
 * branches were permanently dead and nothing said so.
 *
 * This is the specific place a cast does the most damage: argument position is exactly where the
 * compiler would otherwise check a call against its signature. A cast elsewhere loses type
 * information; a cast here loses the check that the caller and the callee agree at all.
 *
 * Casting a VARIABLE (`foo(bar as any)`) is not matched — that is usually narrowing a value
 * whose type is genuinely unknown. What is matched is an object literal written inline and then
 * cast, which can only mean "I do not want the parameter checked".
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
const ALLOWED = new Map([
  [
    'server/db/index.ts',
    'The `{}` is a Proxy TARGET, not a call argument being type-checked against a signature: ' +
      'every property access on it throws by design, so the target is never read and there is no ' +
      'parameter contract for the cast to defeat. The Proxy itself is asserted to the real ' +
      'database type one line later, which is the assertion that matters and is deliberate (P1.2).',
  ],
]);

/**
 * An object literal closing immediately before `as any`, inside a call's argument list.
 * `}` then optional whitespace then `as any` then optional whitespace then `)` or `,`.
 */
const CAST_LITERAL_ARG = /\}\s*as\s+any\s*(?=[),])/g;

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

function hits(source) {
  const code = stripCommentsAndStrings(source);
  CAST_LITERAL_ARG.lastIndex = 0;
  return (code.match(CAST_LITERAL_ARG) || []).length;
}

const violations = [];

// ---------------------------------------------------------------- self-check
/**
 * A scanner that matches nothing reports "ok". Five guardrails on this branch have been caught
 * able to degrade into a silent no-op, so this one proves it still recognises its own subject
 * before it judges anything.
 */
const MUST_MATCH = [
  'compose({ a: 1, b: 2 } as any)',
  'determineNextBestAction(u, s, {} as any, {} as any)',
  'f({\n  a: 1,\n} as any)',
];
const MUST_NOT_MATCH = [
  'const x = { a: 1 } as any;',            // a declaration, not an argument
  'f(bar as any)',                          // narrowing a variable
  'const y = (foo as any).bar;',
  '// compose({ a: 1 } as any)',            // a comment
  "const s = 'compose({ a: 1 } as any)';",  // a string
  'f({ a: 1 } as SomeType)',                // a real type, which the compiler still checks
];

for (const sample of MUST_MATCH) {
  if (hits(sample) === 0) {
    violations.push({
      file: '(self-check)',
      line: 0,
      message: `the scanner no longer recognises a form it exists to catch:\n      ${sample.replace(/\n/g, ' ')}`,
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
const files = [];
for (const root of SCAN_ROOTS) walk(join(ROOT, root), files);
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
  CAST_LITERAL_ARG.lastIndex = 0;
  let match;
  while ((match = CAST_LITERAL_ARG.exec(code)) !== null) {
    const line = code.slice(0, match.index).split('\n').length;
    violations.push({
      file: rel,
      line,
      message:
        'an object literal is cast to `any` in argument position.\n' +
        '      That is precisely where the compiler would otherwise check the call against the ' +
        "function's signature. Give the literal the parameter's type, or fix the call — see " +
        'server/services/inboundPipeline.ts, where this hid four wrong field names and a ' +
        'TypeError on every inbound email.',
    });
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
  console.error(`check-no-cast-call-arguments: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ${v.file}:${v.line}\n      ${v.message}\n`);
  process.exit(1);
}

console.log(`check-no-cast-call-arguments: ok (${examined} files checked, baseline zero)`);
