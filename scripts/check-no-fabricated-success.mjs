#!/usr/bin/env node
/**
 * P1.13 guardrail — an endpoint may not report success for work it did not do.
 *
 * Sixteen handlers were `app.post(route, (req, res) => res.json({ success: true }))`. They
 * mutated nothing, called nothing, and answered 200. Nine of them claimed an EXTERNAL side
 * effect: a reply sent to a customer, a contract signed, ten follow-ups delivered. An operator
 * reading that response has no reason to look again, which is what makes a fabricated success
 * worse than an error — a failure gets investigated.
 *
 * This forbids the shape: a route handler whose entire body is a success response. It is not a
 * ban on `success: true` (a handler that did the work may say so); it is a ban on saying so
 * without doing anything.
 *
 * Comments are stripped first. The replacements document the old code by quoting it, and a
 * check that cannot tell a call site from a description of one is not a check — the P1.12
 * guardrail shipped with exactly that hole.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { relative } from 'node:path';

const ROOT = process.cwd();
// S39 — the routes live in routers now; a check that read only server.ts would pass on an
// empty file. Every router is scanned, and server.ts still, for the mounts.
// A suite may point the scan at files of its own (CHECK_FILES=a,b) to prove the check can fail.
const FILES = process.env.CHECK_FILES
  ? process.env.CHECK_FILES.split(',')
  : ['server.ts', ...readdirSync('server/routes').filter((f) => f.endsWith('.ts')).map((f) => `server/routes/${f}`)];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A handler whose whole body is a success response, in either the arrow-expression form
 * (`(req, res) => res.json({ success: true })`) or the single-statement block form.
 */
/**
 * The route and its parameter list are matched EXPLICITLY rather than with a lazy `[^)]*?`.
 *
 * `[^)]*?` cannot cross a closing paren, and the handler signature is
 * `(req: Request, res: Response) =>` — so a pattern written that way stops at the parameter
 * list's own `)` and never reaches `res.json`. It reported "ok" against the exact arrow-form
 * stub it exists to forbid; the block form matched only by accident of a different shape.
 * This is the same defect as the P1.5 contact guardrail and the P1.12 line-by-line scan.
 */
const ROUTE = String.raw`(?:app|[A-Za-z]+Router)\.(?:post|put|patch|delete)\s*\(\s*["'\`][^"'\`]+["'\`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*`;
const ANY_ROUTE = String.raw`(?:app|[A-Za-z]+Router)\.(?:get|post|put|patch|delete)\s*\(\s*["'\`][^"'\`]+["'\`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*`;
const SUCCESS_CALL = String.raw`res\s*\.\s*json\s*\(\s*\{\s*success\s*:\s*true[^}]*\}\s*\)`;
/**
 * S39 — a fixed answer is a fabricated result even when it does not say `success`.
 *
 * Eight handlers survived the P1.13 pass because their whole body was `res.json({ ... })` with
 * every value a literal: `{ intentConfidence: 0.9 }`, `{ decision: "Proceed" }`, a placeholder
 * sender identity. An operator reading 0.9 has no way to know no classifier ran. A body whose
 * every value is a string, number or boolean literal is such an answer; one that names any
 * identifier is computing something and is not matched.
 */
const LITERAL = String.raw`(?:"[^"]*"|'[^']*'|\d+(?:\.\d+)?|true|false|null)`;
const LITERAL_ANSWER = String.raw`res\s*\.\s*json\s*\(\s*\{\s*(?:\w+\s*:\s*` + LITERAL + String.raw`\s*,?\s*)+\}\s*\)`;

const PATTERNS = [
  {
    label: 'arrow body is a bare success response',
    regex: new RegExp(ROUTE + SUCCESS_CALL, 'gs'),
  },
  {
    label: 'handler block contains nothing but a success response',
    regex: new RegExp(ROUTE + String.raw`\{\s*` + SUCCESS_CALL + String.raw`\s*;?\s*\}`, 'gs'),
  },
  {
    label: 'arrow body is a fixed answer (every value a literal)',
    regex: new RegExp(ANY_ROUTE + LITERAL_ANSWER, 'gs'),
  },
  {
    label: 'block body is a fixed answer (every value a literal)',
    regex: new RegExp(ANY_ROUTE + String.raw`\{\s*` + LITERAL_ANSWER + String.raw`\s*;?\s*\}`, 'gs'),
  },
];

const violations = [];
for (const file of FILES) {
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const { label, regex } of PATTERNS) {
    for (const match of source.matchAll(regex)) {
      violations.push({
        file: relative(ROOT, file),
        line: source.slice(0, match.index).split('\n').length,
        label,
        snippet: match[0].replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }
}

if (violations.length > 0) {
  console.error('An endpoint reports success for work it does not do.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  (${v.label})`);
    console.error(`    ${v.snippet}\n`);
  }
  console.error(
    'Do the work, or answer NOT_IMPLEMENTED through sendError. A handler that says it sent an\n' +
      'email without sending one is worse than one that fails: a failure gets investigated.\n'
  );
  process.exit(1);
}

console.log('check-no-fabricated-success: ok — no endpoint answers success without doing work.');
