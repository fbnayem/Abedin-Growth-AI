#!/usr/bin/env node
/**
 * Fail if a metrics, alerting or audit method has an empty body.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MetricsService.incrementCounter` was, in full:
 *
 *     incrementCounter(metric: 'SEND_SUCCESS' | 'DUPLICATE_BLOCKED' | 'POLICY_BLOCK') {
 *         // Send to metric collector
 *     }
 *
 * A declared metric vocabulary, a comment naming the intent, and no body. Every call would have
 * succeeded. `DUPLICATE_BLOCKED` and `POLICY_BLOCK` were names for things that were counted
 * nowhere — and the method had zero call sites anyway, so nothing even revealed it by being
 * wrong.
 *
 * A discarded metric is worse than an absent one. "Do we have metrics?" is answered yes by the
 * existence of the service, and the question nobody asks is whether the numbers exist. S44's
 * remediation names this check specifically: *fail the build on an empty metric method*.
 *
 * WHAT IT ENFORCES
 * ----------------
 * In the observability modules, a method whose body contains no statement — only whitespace and
 * comments — fails. A comment saying what the method would do if it were implemented is exactly
 * the case being caught, so comments do not count as a body.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not check that the metric is USEFUL, or that it is called from anywhere. A counter
 * incremented into a map nobody reads would pass. That gap is real; this rule is the one that
 * can be enforced by looking at a file, and saying so is better than implying more coverage
 * than it has.
 */

import { readFileSync, existsSync } from 'node:fs';

/** The modules whose whole purpose is to record something. */
const WATCHED = [
  'server/services/metrics.service.ts',
  'server/services/alerting.service.ts',
  'server/domain/operatorAction.ts',
  'server/lib/runLog.ts',
];

/**
 * `private constructor() {}` is the TypeScript singleton idiom: it exists to make the
 * constructor unreachable, and its emptiness is the whole point. Measured rather than assumed —
 * running this against the previous `metrics.service.ts` flagged both `incrementCounter` (the
 * real defect) and the constructor (not one), and a guardrail that fires on correct code gets an
 * exception added to it by the next person, at which point the exception is the rule.
 */
const NOT_OBSERVABILITY = new Set(['constructor']);

/** An interface or type body is a declaration, not an implementation. Skipped by shape below. */
const METHOD = /(?:^|\n)[ \t]*(?:(?:public|private|protected|static|async|export|function)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\{/g;

/**
 * The names of methods in `source` whose bodies contain no statement, and how many were looked
 * at.
 *
 * A function rather than a loop at the top level so the self-check below can call THE SAME CODE
 * against a known sample. It was a loop, and the self-check tested a copy of the comment
 * stripping — so a mutation changing the condition from the stripped body to the raw one
 * survived: the copy still behaved correctly while the real check no longer did.
 */
function emptyBodies(source) {
  const empty = [];
  let examined = 0;

  for (const match of source.matchAll(METHOD)) {
    if (NOT_OBSERVABILITY.has(match[1])) continue;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = source.slice(open + 1, i);
    examined++;

    // Comments stripped: a comment describing the intended implementation is the case this
    // check exists for, and counting it as a body would make the rule unable to fire.
    const withoutComments = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim();

    if (withoutComments.length === 0) empty.push(match[1]);
  }

  return { empty, examined };
}

const offenders = [];
let scanned = 0;
let methodsChecked = 0;

for (const path of WATCHED) {
  if (!existsSync(path)) {
    offenders.push({ path, name: '(file)', why: 'the module is missing entirely' });
    continue;
  }
  scanned++;
  const { empty, examined } = emptyBodies(readFileSync(path, 'utf8'));
  methodsChecked += examined;
  for (const name of empty) {
    offenders.push({
      path,
      name,
      why: 'the body contains no statement — only whitespace and comments',
    });
  }
}

// ---------------------------------------------------------------------------
// Self-check. A rule that matches nothing passes trivially.
// ---------------------------------------------------------------------------
const broken = [];
{
  const sample = `class X {\n  incrementCounter(metric: 'A' | 'B') {\n      // Send to metric collector\n  }\n}`;
  const found = [...sample.matchAll(METHOD)].map((m) => m[1]);
  if (!found.includes('incrementCounter')) {
    broken.push('the method pattern no longer matches the exact shape this was written for');
  }
}
/**
 * The rule, run against the exact shape it was written for — through `emptyBodies`, not a copy
 * of it. `incrementCounter` was never an empty pair of braces: it held
 * `// Send to metric collector`, so a check that counted a comment as a body could not have
 * fired on the one case that mattered.
 *
 * Both directions, because a rule that flags everything is as useless as one that flags nothing.
 */
{
  const sample = [
    'class X {',
    "  incrementCounter(metric: 'A' | 'B') {",
    '      // Send to metric collector',
    '  }',
    '  recordsSomething(n: number) {',
    '    this.total += n;',
    '  }',
    '  blockComment() {',
    '    /* TODO: implement */',
    '  }',
    '}',
  ].join('\n');

  const { empty, examined } = emptyBodies(sample);
  if (examined !== 3) {
    broken.push(`the method pattern found ${examined} of 3 methods in the self-check sample`);
  }
  if (!empty.includes('incrementCounter')) {
    broken.push('a line-comment-only body is no longer judged empty — the original defect passes');
  }
  if (!empty.includes('blockComment')) {
    broken.push('a block-comment-only body is no longer judged empty');
  }
  if (empty.includes('recordsSomething')) {
    broken.push('a body containing a statement is judged empty — this would fail correct code');
  }
}

if (WATCHED.length === 0) broken.push('the watched list is empty, so this enforces nothing');
if (methodsChecked < 10) {
  broken.push(
    `only ${methodsChecked} method bodies were examined across ${scanned} file(s); the ` +
      'pattern is not reaching the code'
  );
}

if (broken.length > 0) {
  console.error('check-no-empty-observability: the scanner is broken —');
  for (const b of broken) console.error('  ' + b);
  process.exit(1);
}

if (offenders.length > 0) {
  for (const o of offenders) {
    console.error(`${o.path}  ${o.name}()`);
    console.error(`    ${o.why}`);
  }
  console.error(
    `\n${offenders.length} observability method(s) record nothing. A discarded metric is worse ` +
      'than an absent one: the service existing is what "do we have metrics?" gets answered with.'
  );
  process.exit(1);
}

console.log(
  `check-no-empty-observability: ok (${scanned} module(s), ${methodsChecked} method bodies; ` +
    'whether a metric is READ is not checked — see the header).'
);
