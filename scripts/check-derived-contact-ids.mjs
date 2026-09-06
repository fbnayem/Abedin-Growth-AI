#!/usr/bin/env node
/**
 * P1.5 guardrail — no contact may be created with a store-assigned random id.
 *
 * `addDoc` asks Firestore for a fresh random document id. For a contact that defeats the only
 * uniqueness Firestore offers, and duplicates are not a tidiness problem: ActionGateway decides
 * whether someone may be emailed by loading ONE contact document and reading its suppression
 * flags, so an unsubscribe recorded on one copy leaves the person mailable through the other.
 *
 * This checks the property that matters — that nothing writes a contact at an id the store
 * chose — rather than counting call sites. Ratchets can be argued down; this cannot.
 *
 * Scans whole files rather than lines, because the P1.12 guardrail was written line-by-line
 * and missed every multi-line body: thirteen of them, including both webhook handlers.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['server'];
const SCAN_FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'tests']);

const ADD_DOC_ANY = /addDoc\s*\(/g;

/**
 * Extract the text of a call's argument list by matching brackets.
 *
 * The obvious regex — `addDoc\(\s*collection\([^)]*'contacts'` — does not work, and it fails
 * silently. `[^)]*` cannot cross a closing paren, and the real call is
 * `collection(firestore, orgPath(orgScope(req), 'contacts'))`: the scan stops at the first
 * `)` of `orgScope(req)` and never reaches the collection name. Written that way, this script
 * reported "ok" against a file containing the exact call it exists to forbid — measured, not
 * assumed. So the arguments are matched by counting brackets instead.
 */
function callArguments(source, openParenIndex) {
  let depth = 0;
  let inString = null;
  for (let i = openParenIndex; i < source.length; i++) {
    const char = source[i];
    const prev = source[i - 1];

    if (inString) {
      if (char === inString && prev !== '\\') inString = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = char;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return null;
}

function collect(dir, out) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Remove comments so a documented example is not reported as a call site. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const files = [...SCAN_FILES.map((f) => join(ROOT, f))];
for (const dir of SCAN_DIRS) collect(join(ROOT, dir), files);

const violations = [];
let totalAddDoc = 0;

for (const file of files) {
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(ADD_DOC_ANY)) {
    totalAddDoc++;
    const args = callArguments(source, match.index + match[0].length - 1);
    if (args === null) continue;
    // The collection is the first argument. Splitting on the top-level comma is unnecessary:
    // a `contacts` collection name anywhere in the call is the thing being forbidden.
    if (!/['"`]contacts['"`]/.test(args)) continue;
    violations.push({
      file: relative(ROOT, file),
      line: source.slice(0, match.index).split('\n').length,
      snippet: `addDoc(${args})`.replace(/\s+/g, ' ').slice(0, 110),
    });
  }
}

if (violations.length > 0) {
  console.error('A contact is being created at a store-assigned random id.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}\n`);
  }
  console.error(
    'Use createContactIfAbsent() from server/lib/identityStore. It derives the document id\n' +
      'from the normalised address, so the same person is the same document, and it REFUSES\n' +
      'when the document exists rather than overwriting the suppression and consent flags.\n'
  );
  process.exit(1);
}

console.log(
  `check-derived-contact-ids: ok — no contact is created with a store-assigned id ` +
    `(${totalAddDoc} addDoc call${totalAddDoc === 1 ? '' : 's'} elsewhere, none into contacts).`
);
