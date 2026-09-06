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

const offenders = [];

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

if (offenders.length > 0) {
  console.error(
    `${offenders.length} hand-built error body/bodies found. Use sendError() or sendCaught() ` +
      `from server/lib/errors.ts, so every failure carries a stable code and a requestId, and ` +
      `no internal message reaches the caller (P1.12).\n`
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log('OK: every error goes through the envelope.');
