#!/usr/bin/env node
/**
 * S35 / S16 — fail if untrusted HTML acquires a way to execute, or a name that lies about it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The audit found that this application stores raw provider HTML and is "safe today only by
 * absence of a sink" — there is no `dangerouslySetInnerHTML` anywhere in `src/`. The addendum's
 * grading standard rejects that as an argument: "nothing broke yet" is not a control. One
 * component added by someone who wanted rich email preview turns a stored-XSS hole on, and the
 * credential it would exfiltrate is a live Gmail SEND token sitting in `localStorage`.
 *
 * So the absence is made into a control. The scan fails on:
 *
 *   1. Any HTML sink — `dangerouslySetInnerHTML`, `innerHTML =`, `outerHTML =`,
 *      `insertAdjacentHTML`, `document.write`. If one is ever genuinely needed, it needs a real
 *      sanitizer landing in the same change, and this file is where that argument gets made.
 *
 *   2. The identifier `sanitizedHtmlBody`. The column held raw provider HTML under a name
 *      asserting it had been sanitized — a reviewer reading the schema would reasonably conclude
 *      a sanitizer existed somewhere. It is `rawHtmlBody` now, and the old name must not return.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a claim that the application sanitizes HTML. It does not: it renders provider HTML
 * to TEXT (`htmlToText` in `server/lib/mime.ts`) and keeps the original under a name that says
 * it is untrusted. This check holds the boundary that makes that safe.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_ROOTS = ['server', 'src', 'shared'];
const SCAN_FILES = ['server.ts', 'index.html'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.html'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

const RULES = [
  {
    id: 'HTML_SINK',
    pattern: /\bdangerouslySetInnerHTML\b|\.innerHTML\s*=|\.outerHTML\s*=|\binsertAdjacentHTML\s*\(|\bdocument\s*\.\s*write\s*\(/g,
    message:
      'an HTML sink. Untrusted provider HTML is stored in this system; rendering it executes it. ' +
      'Use the text rendering (htmlToText) — or land a real sanitizer in the same change and ' +
      'amend this guardrail deliberately.',
  },
  {
    id: 'LYING_NAME',
    pattern: /\bsanitizedHtmlBody\b|\bsanitized_html_body\b/g,
    message:
      'the name `sanitizedHtmlBody`, which asserted a property no code in this repository ' +
      'provides. The field is `rawHtmlBody`, and the text rendering is `htmlAsText`.',
  },
];

/** Comments may name these things — that is how the reasons get recorded. */
function stripCommentsAndStrings(source) {
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
    if (source[i] === '<' && source.slice(i, i + 4) === '<!--') {
      i += 4;
      while (i < n && source.slice(i, i + 3) !== '-->') i++;
      i += 3;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

const offenders = [];

function check(path) {
  const raw = readFileSync(path, 'utf8');
  const code = stripCommentsAndStrings(raw);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let m;
    while ((m = rule.pattern.exec(code)) !== null) {
      offenders.push({
        path: relative(process.cwd(), path),
        rule: rule.id,
        match: m[0].trim(),
        message: rule.message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Self-check FIRST. A scan that silently covers nothing reports success, and a guardrail
// mistaken for coverage is worse than no guardrail — this repository has shipped two of those.
// ---------------------------------------------------------------------------
const SELF_CHECK_CASES = [
  { rule: 'HTML_SINK', source: 'const x = <div dangerouslySetInnerHTML={{__html: body}} />;' },
  { rule: 'HTML_SINK', source: 'el.innerHTML = untrusted;' },
  { rule: 'HTML_SINK', source: 'el.outerHTML  =  untrusted;' },
  { rule: 'HTML_SINK', source: 'el.insertAdjacentHTML("beforeend", untrusted);' },
  { rule: 'HTML_SINK', source: 'document.write(untrusted);' },
  { rule: 'LYING_NAME', source: 'const b = row.sanitizedHtmlBody;' },
  { rule: 'LYING_NAME', source: "text('sanitized_html_body')" },
];
const MUST_NOT_MATCH = [
  '// dangerouslySetInnerHTML is banned here, see check-no-html-sink.mjs',
  '/* the column was called sanitizedHtmlBody */',
  'const html = htmlToText(row.rawHtmlBody);',
  'element.textContent = untrusted;',
];

const selfFailures = [];
for (const c of SELF_CHECK_CASES) {
  const rule = RULES.find((r) => r.id === c.rule);
  rule.pattern.lastIndex = 0;
  if (!rule.pattern.test(stripCommentsAndStrings(c.source))) {
    selfFailures.push(`the ${c.rule} rule did NOT catch: ${c.source}`);
  }
}
for (const source of MUST_NOT_MATCH) {
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(stripCommentsAndStrings(source))) {
      selfFailures.push(`the ${rule.id} rule wrongly caught: ${source}`);
    }
  }
}
// A self-check with an empty case list passes vacuously — the exact hole found in
// check-no-cast-call-arguments. Assert the lists are populated.
if (SELF_CHECK_CASES.length < 7 || MUST_NOT_MATCH.length < 4) {
  selfFailures.push('the self-check case lists have been emptied, so the self-check proves nothing');
}
if (selfFailures.length > 0) {
  console.error('check-no-html-sink: THE CHECK ITSELF IS BROKEN.');
  for (const f of selfFailures) console.error('  - ' + f);
  process.exit(1);
}

// ---------------------------------------------------------------------------
let filesScanned = 0;
function checkCounting(path) {
  filesScanned++;
  check(path);
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
        checkCounting(join(dir, entry.name));
      }
    }
  })(root);
}
for (const file of SCAN_FILES) {
  try {
    if (statSync(file).isFile()) checkCounting(file);
  } catch {
    // Optional file.
  }
}

// An empty scan is a broken scan, not a clean one. `check-no-cast-call-arguments` once passed
// with SCAN_ROOTS emptied because a single file still came in through SCAN_FILES.
if (filesScanned < 50) {
  console.error(
    `check-no-html-sink: only ${filesScanned} files were scanned. That is too few to be a real ` +
      'scan of this repository — the roots or the extension list are wrong.'
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(`check-no-html-sink: ${offenders.length} offender(s).`);
  for (const o of offenders) {
    console.error(`  ${o.path}: \`${o.match}\` — ${o.message}`);
  }
  process.exit(1);
}

console.log(
  `check-no-html-sink: ok (${filesScanned} files scanned, no HTML sink and no name claiming ` +
    'a sanitizer that does not exist)'
);
