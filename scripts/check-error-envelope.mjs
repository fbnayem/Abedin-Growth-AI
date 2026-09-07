#!/usr/bin/env node
/**
 * P1.12 (§12) — server/lib/errors.ts is the only place that builds a client-visible error.
 *
 * A hand-built `res.json({ error: ... })` looks identical to the real thing and is not: it
 * carries no requestId, because only `sendError` knows about it, and it may echo an internal
 * message the envelope would have kept in the log. That drift happened once already — WHILE
 * removing it, in the very functions written to prevent it — and was caught by comparing
 * actual HTTP responses, not by reading the code. Hence a check.
 *
 * Written as a script rather than a CI grep because the shell and YAML escaping needed to
 * express this pattern inline is exactly the kind of thing that silently stops matching.
 *
 * SECOND RULE — THE CODE MUST EXIST.
 *
 * The check above proves every error goes through the envelope, and says nothing about what the
 * envelope was handed. Two routes were passing `'FORBIDDEN' as ErrorCode`, and there has never
 * been a `FORBIDDEN` in the taxonomy. The cast is what let it compile.
 *
 * The consequence is not cosmetic. `sendError` computes `options.status ?? ErrorCodes[code] ??
 * 500`, so an unknown code answers **500** unless the call site also passes an explicit status
 * — both of these did, which is exactly why nothing ever looked wrong. The body still carried a
 * `code` no client could branch on, and branching on a stable code rather than on prose is the
 * entire reason this envelope exists.
 *
 * So the second rule reads the taxonomy out of `server/lib/errors.ts` and checks every literal
 * code handed to `sendError`. A code assembled from a variable cannot be checked here, and that
 * is stated rather than implied away.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server'];
const FILES = ['server.ts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);
/** The one module allowed to construct an error body. */
const ALLOWED = new Set(['server/lib/errors.ts']);

/**
 * Matched against the WHOLE FILE, not line by line.
 *
 * The first version of this check scanned lines, and missed the two webhook handlers because
 * they write the body across several lines:
 *
 *     return res.status(401).json({
 *       error: { code: 'WEBHOOK_VERIFICATION_FAILED', message: verification.reason },
 *     });
 *
 * A line-oriented check on a construct that spans lines is a guardrail with a hole in exactly
 * the shape of prettier's output. Found by comparing HTTP responses again, not by reading it.
 */
const PATTERN = /json\(\s*\{\s*error\s*:/g;

/** `sendError(req, res, 'CODE'` — the literal-code form, the only one that can be checked. */
const CODE_PATTERN = /sendError\s*\(\s*[^,]+,\s*[^,]+,\s*'([A-Z_][A-Z0-9_]*)'/g;

/** The taxonomy, read from the source of truth rather than duplicated here. */
function knownCodes() {
  const source = readFileSync('server/lib/errors.ts', 'utf8');
  const block = source.match(/export const ErrorCodes = \{([\s\S]*?)\n\} as const;/);
  if (!block) {
    console.error('check-error-envelope: cannot find ErrorCodes in server/lib/errors.ts.');
    process.exit(1);
  }
  const codes = new Set();
  for (const m of block[1].matchAll(/^\s{2}([A-Z_][A-Z0-9_]*)\s*:/gm)) codes.add(m[1]);
  return codes;
}

const CODES = knownCodes();
if (CODES.size < 20) {
  console.error(
    `check-error-envelope: only ${CODES.size} error codes parsed, expected at least 20. ` +
      'The taxonomy parser is not reading the source.'
  );
  process.exit(1);
}

const offenders = [];
const unknownCodes = [];

/** Line number of a character offset, for a useful message. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function scan(path) {
  const rel = relative(process.cwd(), path).split('\\').join('/');
  if (ALLOWED.has(rel)) return;

  const source = readFileSync(path, 'utf8');

  // Strip line and block comments so a doc comment quoting the bad pattern (as several in this
  // repository now do, to explain why it was removed) is not reported as the defect.
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

  for (const match of stripped.matchAll(PATTERN)) {
    const line = lineOf(source, match.index ?? 0);
    offenders.push(`${rel}:${line}  ${source.split('\n')[line - 1].trim()}`);
  }

  for (const match of stripped.matchAll(CODE_PATTERN)) {
    if (CODES.has(match[1])) continue;
    const line = lineOf(source, match.index ?? 0);
    unknownCodes.push(`${rel}:${line}  '${match[1]}' is not in ErrorCodes`);
  }
}

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
    } else if (entry.name.endsWith('.ts')) {
      scan(join(dir, entry.name));
    }
  }
}

for (const root of ROOTS) walk(root);
for (const file of FILES) {
  try {
    if (statSync(file).isFile()) scan(file);
  } catch {
    // Optional.
  }
}

// ---------------------------------------------------------------------------
// Self-check, through the same parser and pattern the scan uses.
// ---------------------------------------------------------------------------
{
  const broken = [];
  if (!CODES.has('VALIDATION_ERROR')) broken.push('the taxonomy parser missed VALIDATION_ERROR');
  if (CODES.has('FORBIDDEN')) {
    broken.push('FORBIDDEN parsed as a real code — it is the fixture this rule was written for');
  }
  const sample = "sendError(req, res, 'NOPE_NOT_REAL', m);\nsendError(req, res, 'NOT_FOUND', m);";
  const found = [...sample.matchAll(CODE_PATTERN)].map((m) => m[1]);
  if (!found.includes('NOPE_NOT_REAL')) broken.push('the code pattern no longer matches a call');
  if (!found.includes('NOT_FOUND')) broken.push('the code pattern matches only the first call');
  if (broken.length > 0) {
    console.error('check-error-envelope: the scanner is broken —');
    for (const b of broken) console.error('  ' + b);
    process.exit(1);
  }
}

if (unknownCodes.length > 0) {
  console.error(
    `${unknownCodes.length} error code(s) outside the taxonomy. sendError computes ` +
      '`ErrorCodes[code] ?? 500`, so an unknown code answers 500 unless the call site also ' +
      'passes a status — and the client is handed a code it cannot branch on. Add it to ' +
      'ErrorCodes in server/lib/errors.ts, or use one that exists.\n'
  );
  for (const o of unknownCodes) console.error(`  ${o}`);
  process.exit(1);
}

if (offenders.length > 0) {
  console.error(
    `${offenders.length} hand-built error body/bodies found. Use sendError() or sendCaught() ` +
      `from server/lib/errors.ts, so every failure carries a stable code and a requestId, and ` +
      `no internal message reaches the caller (P1.12).\n`
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log(
  'OK: every error goes through the envelope, and every literal code is one of the ' +
    `${CODES.size} in the taxonomy.`
);
