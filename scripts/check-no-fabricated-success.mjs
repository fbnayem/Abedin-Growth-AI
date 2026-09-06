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
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const ROOT = process.cwd();
const FILES = ['server.ts'];

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
const ROUTE = String.raw`app\.(?:post|put|patch|delete)\s*\(\s*["'\`][^"'\`]+["'\`]\s*,\s*(?:async\s*)?\([^)]*\)\s*=>\s*`;
const SUCCESS_CALL = String.raw`res\s*\.\s*json\s*\(\s*\{\s*success\s*:\s*true[^}]*\}\s*\)`;

const PATTERNS = [
  {
    label: 'arrow body is a bare success response',
    regex: new RegExp(ROUTE + SUCCESS_CALL, 'gs'),
  },
  {
    label: 'handler block contains nothing but a success response',
    regex: new RegExp(ROUTE + String.raw`\{\s*` + SUCCESS_CALL + String.raw`\s*;?\s*\}`, 'gs'),
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
