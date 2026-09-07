#!/usr/bin/env node
/**
 * S24 — fail if a send verdict is reached by arithmetic, or if a control's result is a
 * hardcoded literal rather than something a check computed.
 *
 * WHY THIS EXISTS
 * ---------------
 * `independentAuditor.ts` decided whether a customer-facing reply could be sent like this:
 *
 *     let score = 100;
 *     ...
 *     score -= 15;   // draft used a CTA the plan withheld
 *     score -= 40;   // draft states a price this customer may not be quoted
 *     score -= 30;   // draft contains an ungrounded claim
 *     const finalDecision = score >= 90 ? "PASS" : score >= 70 ? "REWRITE" : "ESCALATE";
 *
 * and recorded what its controls had found like this:
 *
 *     deterministicSafetyResult: {
 *       zeroPhoneClean: true, semanticLinkClean: true, mergeTagsClean: true,
 *       suppressionClean: true, duplicateLockClean: true, circuitBreakerClean: true,
 *     }
 *
 * — six literals, on all four return paths, while the real `phoneRes.flagged`,
 * `linkRes.flagged` and `tagRes.flagged` values sat in scope. Three of the six could never be
 * `false` in any execution, in any input, ever.
 *
 * Both defects have the same shape: a number or a constant standing in for a judgement.
 * Neither is caught by the compiler, by a type, or by a test of the happy path, because both
 * produce perfectly well-formed output.
 *
 * A second instance was found by this check on its first run and deleted:
 * `server/agents/qualityControlAgent.ts` combined a deterministic phone-policy result with a
 * model opinion as
 *
 *     decision: hasPhoneNumbers ? (data.decision === "BLOCK" ? "BLOCK" : "PASS") : ...
 *
 * — so a draft that DID contain a phone number was forced to PASS unless the model happened to
 * say BLOCK, while `phonePolicyFlagged: true` was returned alongside it.
 *
 * WHAT IT SCANS FOR
 * -----------------
 *   1. VERDICT_FROM_THRESHOLD — a send verdict chosen by comparing a number to a literal.
 *   2. SAFETY_SCORE_ACCUMULATOR — a running total in a file that also decides a send verdict.
 *   3. LITERAL_SAFETY_CLAIM — a property whose name asserts a safety property, assigned `true`.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a ban on numbers. `computePurchaseReadiness` and `computeMeetingReadiness` add and
 * subtract from a 0-100 score, and should: a readiness estimate genuinely is a quantity. That
 * is what the file gate on rule 2 is for. The rule is about a number deciding whether an email
 * is sent, which is what `server/domain/adjudication.ts` replaced — there the verdict is the
 * severity of the worst finding, with no total to trade against.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_ROOTS = ['server', 'shared', 'src'];
const SCAN_FILES = ['server.ts'];
const EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

/**
 * A file "produces a verdict" when one of the four send verdicts appears in it as a quoted
 * value. Comments are stripped before this is evaluated, so prose describing the old code —
 * which every one of these fixes leaves behind deliberately — does not open the gate.
 *
 * The consequence of the gate is intended: if a verdict-producing function is ever added to a
 * file that already keeps a score, this check starts failing there. That is the moment to
 * look, not a false positive to suppress.
 */
const VERDICT_VALUE = /(?<![\w.])["'](?:PASS|REWRITE|ESCALATE|BLOCK)["']/;

const RULES = [
  {
    id: 'VERDICT_FROM_THRESHOLD',
    fileGated: false,
    pattern: /[<>]=?\s*[\d_.]+\s*\?\s*[^;{}]{0,120}?["'](?:PASS|REWRITE|ESCALATE|BLOCK)["']/g,
    message:
      'a send verdict chosen by comparing a number to a threshold. Findings of different kinds ' +
      'summed into one scalar become tradeable against each other, and the thresholds meant to ' +
      'separate them can be unreachable without anyone noticing — measured, the auditor -40 and ' +
      '-30 always fired together, so its 60 and 70 never occurred. Use adjudicate() in ' +
      'server/domain/adjudication.ts: the verdict is the severity of the worst finding.',
  },
  {
    id: 'SAFETY_SCORE_ACCUMULATOR',
    // Only in a file that also produces a send verdict. See VERDICT_VALUE above.
    fileGated: true,
    pattern: /\b(?:score|penalty|penalties|riskScore|safetyScore|auditScore)\s*(?:-=|\+=)/g,
    message:
      'a running total accumulated in a file that also decides a send verdict. Readiness and ' +
      'confidence numbers are fine where they are genuinely quantities, but a verdict must not ' +
      'be derived from one — record findings with a severity and call adjudicate().',
  },
  {
    id: 'LITERAL_SAFETY_CLAIM',
    fileGated: false,
    pattern:
      /\b\w*(?:Clean|Safe|Verified|Sanitized|Sanitised|Grounded|Validated|Checked)\s*:\s*true\b/g,
    message:
      'a safety property recorded as the literal `true`. A control that ran produces a value; ' +
      'a literal asserts an outcome for work that may not have happened — and cannot express ' +
      '"this check did not run", so an unrun check gets written as the safe-looking one. Use ' +
      'CheckOutcome (CLEAN | VIOLATED | NOT_RUN) and derive it from what the check returned.',
  },
];

/**
 * Comments only. String contents are KEPT, because the verdict rules are about quoted verdict
 * values and blanking strings would make them match nothing — which is how a guardrail passes
 * while covering zero of what it was written for.
 */
function stripComments(source) {
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
    out += source[i];
    i++;
  }
  return out;
}

function findingsIn(code) {
  const producesVerdict = VERDICT_VALUE.test(code);
  const hits = [];
  for (const rule of RULES) {
    if (rule.fileGated && !producesVerdict) continue;
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(code)) !== null) {
      hits.push({ rule: rule.id, match: m[0].trim(), message: rule.message });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Self-check FIRST. A scan that silently covers nothing reports success, and a guardrail
// mistaken for coverage is worse than no guardrail. This repository has shipped two of those:
// check-no-cast-call-arguments once passed with its roots emptied, and the first version of
// check-abstention-ratchet counted 6 call sites where grep found 14.
// ---------------------------------------------------------------------------

// Each case is run through the same `findingsIn` the real scan uses, INCLUDING the file gate,
// so the accumulator cases carry a verdict value the way the real offender did.
const SELF_CHECK_CASES = [
  { rule: 'VERDICT_FROM_THRESHOLD', source: 'const d = score >= 90 ? "PASS" : "REWRITE";' },
  {
    rule: 'VERDICT_FROM_THRESHOLD',
    source: 'const d = score >= 90 ? "PASS" : score >= 70 ? "REWRITE" : "ESCALATE";',
  },
  { rule: 'VERDICT_FROM_THRESHOLD', source: "return risk > 70 ? 'BLOCK' : 'PASS';" },
  { rule: 'VERDICT_FROM_THRESHOLD', source: 'const d = n >= 0.85 ? "PASS" : "ESCALATE";' },
  { rule: 'SAFETY_SCORE_ACCUMULATOR', source: 'const v = "PASS"; score -= 15;' },
  { rule: 'SAFETY_SCORE_ACCUMULATOR', source: 'const v = "BLOCK"; score  -=  40;' },
  { rule: 'SAFETY_SCORE_ACCUMULATOR', source: 'const v = "REWRITE"; safetyScore += 10;' },
  { rule: 'LITERAL_SAFETY_CLAIM', source: 'return { zeroPhoneClean: true };' },
  { rule: 'LITERAL_SAFETY_CLAIM', source: '{ suppressionClean:true, x: 1 }' },
  { rule: 'LITERAL_SAFETY_CLAIM', source: '{ isVerified: true }' },
  { rule: 'LITERAL_SAFETY_CLAIM', source: '{ mergeTagsSanitized: true }' },
];

const MUST_NOT_MATCH = [
  // Prose recording what the code used to do. Every fix in this repository leaves one behind,
  // so a check that fires on them would be switched off within a week.
  '// score -= 15 was here before adjudicate() replaced it',
  '/* deterministicSafetyResult: { zeroPhoneClean: true } */',
  '// const finalDecision = score >= 90 ? "PASS" : "REWRITE";',
  // The replacement shapes.
  'zeroPhone: outcomeFromViolation(phoneRes.flagged),',
  'suppression: "CLEAN",',
  'const verdict = adjudicate(findings);',
  'zeroPhoneClean: phoneRes.flagged === false,',
  // Numbers that are genuinely quantities. The last two are the readiness scorers verbatim:
  // they live in a file with no verdict value in it, and the file gate is what spares them.
  'const readiness = purchaseReadiness.score >= 85;',
  'if (attempts >= 3) return;',
  'score += 55; signals.push("+55 Direct readiness to onboard / purchase");',
  'let score = 30; score -= 15;',
];

const selfFailures = [];
for (const c of SELF_CHECK_CASES) {
  const hits = findingsIn(stripComments(c.source));
  if (!hits.some((h) => h.rule === c.rule)) {
    selfFailures.push(`the ${c.rule} rule did NOT catch: ${c.source}`);
  }
}
for (const source of MUST_NOT_MATCH) {
  const hits = findingsIn(stripComments(source));
  for (const h of hits) {
    selfFailures.push(`the ${h.rule} rule wrongly caught: ${source}`);
  }
}

// The FILE GATE, in both directions. A gate stuck open makes rule 2 fire on every readiness
// scorer; a gate stuck shut makes it fire on nothing, which is how a guardrail silently stops
// covering the file it was written for.
const GATED = RULES.find((r) => r.id === 'SAFETY_SCORE_ACCUMULATOR');
if (GATED === undefined || GATED.fileGated !== true) {
  selfFailures.push('SAFETY_SCORE_ACCUMULATOR is no longer file-gated');
}
if (VERDICT_VALUE.test(stripComments('let score = 0; score += 5;'))) {
  selfFailures.push('the verdict gate opened on a file with no verdict in it');
}
if (!VERDICT_VALUE.test(stripComments('return { decision: "PASS" };'))) {
  selfFailures.push('the verdict gate did not open on a file that returns PASS');
}
if (VERDICT_VALUE.test(stripComments('// the old code returned "PASS" here'))) {
  selfFailures.push('the verdict gate opened on prose rather than code');
}

// An emptied case list passes vacuously — the exact hole described above.
if (SELF_CHECK_CASES.length < 11 || MUST_NOT_MATCH.length < 11) {
  selfFailures.push('the self-check case lists have been emptied, so the self-check proves nothing');
}
// Every rule must be exercised, so deleting one and leaving the others cannot pass.
for (const rule of RULES) {
  if (!SELF_CHECK_CASES.some((c) => c.rule === rule.id)) {
    selfFailures.push(`rule ${rule.id} has no positive self-check case`);
  }
}

if (selfFailures.length > 0) {
  console.error('check-no-verdict-arithmetic: THE CHECK ITSELF IS BROKEN.');
  for (const f of selfFailures) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------------------------------
const offenders = [];
let filesScanned = 0;

function check(path) {
  filesScanned++;
  const code = stripComments(readFileSync(path, 'utf8'));
  for (const hit of findingsIn(code)) {
    offenders.push({ path: relative(process.cwd(), path), ...hit });
  }
}

for (const root of SCAN_ROOTS) {
  (function walk(dir) {
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
  })(root);
}
for (const file of SCAN_FILES) {
  try {
    if (statSync(file).isFile()) check(file);
  } catch {
    // Optional file.
  }
}

// An empty scan is a broken scan, not a clean one.
if (filesScanned < 50) {
  console.error(
    `check-no-verdict-arithmetic: only ${filesScanned} files were scanned. That is too few to ` +
      'be a real scan of this repository — the roots or the extension list are wrong.'
  );
  process.exit(1);
}

// The auditor is the file this exists for. If it stops being scanned — renamed, moved, or the
// roots narrowed — the check would go green while covering nothing that matters.
const AUDITOR = 'server/agents/independentAuditor.ts';
try {
  if (!statSync(AUDITOR).isFile()) throw new Error('not a file');
} catch {
  console.error(
    `check-no-verdict-arithmetic: ${AUDITOR} was not found. This check exists for that file; ` +
      'if it has genuinely moved, point this constant at the new path deliberately.'
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`check-no-verdict-arithmetic: ${offenders.length} offender(s).`);
  for (const o of offenders) {
    console.error(`  ${o.path}: \`${o.match}\` — ${o.message}`);
  }
  process.exit(1);
}

console.log(`check-no-verdict-arithmetic: clean (${filesScanned} files, ${RULES.length} rules).`);
