#!/usr/bin/env node
/**
 * Fail if any source file contains a raw NUL byte.
 *
 * WHY THIS IS A SCRIPT AND NOT A GREP
 * -----------------------------------
 * The obvious check is `grep -rlP "\x00" src/`. It does not work, and it does not work in the
 * worst possible way: grep classifies a file containing a NUL as binary and skips it, so the
 * check passes on exactly the files it was written to catch. It was verified to return exit 1
 * (no matches) against a file that definitely contains one. A guardrail that cannot fail is
 * worse than no guardrail, because it is mistaken for coverage.
 *
 * WHY THE CHECK EXISTS
 * --------------------
 * Twice a raw NUL has ended up in a .ts file here — once as a digest delimiter written as a
 * byte instead of the escape U+0000, once in a test fixture. Both compiled and both ran
 * correctly, so nothing downstream complained. But git shows such a file as "Binary files
 * differ" (no reviewable diff), grep skips it, and every other grep-based guardrail in CI
 * silently excludes it. Write the escape, not the byte.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['server', 'src', 'shared', 'scripts', '.github'];
const FILES = ['server.ts', 'vitest.config.ts', 'vite.config.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

const offenders = [];

function check(path) {
  const buf = readFileSync(path);
  const index = buf.indexOf(0);
  if (index === -1) return;

  // Report where, with context, so the fix is obvious rather than a hunt.
  const line = buf.subarray(0, index).toString('utf8').split('\n').length;
  const context = buf
    .subarray(Math.max(0, index - 50), index + 10)
    .toString('utf8')
    .split(String.fromCharCode(0)).join('<NUL>')
    .replace(/\n/g, '\\n');
  offenders.push({ path: relative(process.cwd(), path), line, context });
}

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // A root that does not exist is not an error.
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      check(join(dir, entry.name));
    }
  }
}

for (const root of ROOTS) walk(root);
for (const file of FILES) {
  try {
    if (statSync(file).isFile()) check(file);
  } catch {
    // Optional file.
  }
}

if (offenders.length > 0) {
  for (const o of offenders) {
    console.error(`${o.path}:${o.line}  raw NUL byte`);
    console.error(`    ...${o.context}`);
  }
  console.error(
    `\n${offenders.length} file(s) contain a raw NUL byte. Use the escape sequence \\u0000 ` +
      `instead — a file containing the byte is treated as binary by git and grep, which means ` +
      `no diff in review and no match in any other guardrail.`
  );
  process.exit(1);
}

console.log('OK: no raw NUL bytes in source.');
