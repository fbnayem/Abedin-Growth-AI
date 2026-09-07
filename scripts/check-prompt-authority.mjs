#!/usr/bin/env node
/**
 * P1.10 (§18) — A RATCHET ON PROMPT AUTHORITY.
 *
 * `safeGenerateJSON` accepts two shapes:
 *
 *   { prompt }                          one string, one level of authority — legacy
 *   { systemInstruction, contents }     instructions and untrusted material separated
 *
 * The legacy form is safe only when every part of the string was written by us. It is not safe
 * for anything carrying a customer's email, a scraped page, or an attachment, because
 * interpolating that text into the instruction gives it the same authority as the instruction.
 *
 * Migrating every call site at once is not realistic — there are a dozen agents, several of
 * them unreachable, and each needs its own judgement about which values are untrusted. So this
 * is a RATCHET rather than a ban: the number of legacy call sites may go DOWN and may not go
 * UP. New model calls must use the separated form; existing ones can be migrated in order of
 * risk.
 *
 * A ratchet is used here deliberately in preference to a rule that greps for "untrusted-looking
 * interpolation". That rule would be guesswork about variable names, would produce false
 * positives, and — worse — would pass on the real thing the moment someone renamed a variable.
 * Counting is something a script can actually be right about.
 *
 * When you migrate a call site, lower BASELINE. It should reach 0.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Legacy call sites remaining at the time of writing.
 *
 * Migrated so far (the two on the live inbound path, in risk order):
 *   - salesDecisionEngine.composeAutonomousSalesReply — interpolated the customer's raw email
 *     into the instruction inside two double quotes.
 *   - conversationMemoryAgent.extractAndSynthesizeMemory — interpolated the ENTIRE conversation
 *     transcript, and runs on every inbound message with no feature flag.
 */
const BASELINE = 10;

const ROOT = 'server';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);

const offenders = [];

/**
 * Blank comments and string bodies, preserving line numbers and offsets.
 *
 * Without this, a file that merely NAMES `safeGenerateJSON` in a doc comment was scanned, and
 * every `prompt:` in it counted — which is how `server/lib/modelCallLog.ts` became an offender
 * for a field of a hash function.
 */
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
        if (source[j] === '\\') { j += 2; continue; }
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

/**
 * The character span of each `safeGenerateJSON( ... )` call, by matching parentheses.
 *
 * The optional generic argument is skipped: most real call sites in this codebase are written
 * `safeGenerateJSON<{ steps?: any[] }>({ prompt, ... })`, and a needle of `safeGenerateJSON(`
 * matches none of them — which made this scanner report ZERO offenders where there were 16.
 */
function callSpans(code) {
  const spans = [];
  const needle = 'safeGenerateJSON';
  let from = 0;
  for (;;) {
    const at = code.indexOf(needle, from);
    if (at === -1) break;
    from = at + needle.length;

    let i = from;
    while (i < code.length && /\s/.test(code[i])) i++;
    // Skip a balanced generic argument list, if one is present.
    if (code[i] === '<') {
      let angle = 0;
      for (; i < code.length; i++) {
        if (code[i] === '<') angle++;
        else if (code[i] === '>') {
          angle--;
          if (angle === 0) { i++; break; }
        }
      }
      while (i < code.length && /\s/.test(code[i])) i++;
    }
    if (code[i] !== '(') continue; // a mention, not a call

    let depth = 0;
    let end = i;
    for (let j = i; j < code.length; j++) {
      if (code[j] === '(') depth++;
      else if (code[j] === ')') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    spans.push([i, end]);
  }
  return spans;
}

function scan(path) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes('safeGenerateJSON')) return;

  // Only `prompt:` INSIDE a safeGenerateJSON call counts. The check is about a model call
  // using the legacy single-string form, not about the word `prompt` appearing in a file —
  // and an object literal passed to something else (a hash, a log record) is neither a model
  // call nor an authority boundary.
  const code = stripCommentsAndStrings(source);
  const spans = callSpans(code);
  if (spans.length === 0) return;

  const lineStarts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  // `prompt` as a KEY of the options object: `{ prompt, ... }` shorthand or `{ prompt: expr }`.
  //
  // Anchoring on the preceding `{` or `,` is what separates a key from a value. Without it,
  // `safeGenerateJSON({ contents: prompt, ... })` — the SAFE form, where the untrusted material
  // simply lives in a variable called `prompt` — would be reported as a legacy call site.
  const LEGACY = /[{,]\s*prompt\s*[,}:]/g;
  for (const [start, end] of spans) {
    const segment = code.slice(start, end + 1);
    LEGACY.lastIndex = 0;
    let match;
    while ((match = LEGACY.exec(segment)) !== null) {
      offenders.push({ path: relative(process.cwd(), path), line: lineOf(start + match.index) });
    }
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (entry.name.endsWith('.ts')) {
      scan(join(dir, entry.name));
    }
  }
}

try {
  if (statSync(ROOT).isDirectory()) walk(ROOT);
} catch {
  console.error(`Cannot read ${ROOT}/`);
  process.exit(1);
}

const count = offenders.length;

if (count > BASELINE) {
  console.error(
    `Prompt-authority ratchet: ${count} legacy single-string call sites, baseline is ${BASELINE}.\n` +
      `A NEW model call is using { prompt } instead of { systemInstruction, contents }.\n` +
      `If it carries any externally retrieved material, build it with server/lib/promptAssembly.ts (§18).\n`
  );
  for (const o of offenders) console.error(`  ${o.path}:${o.line}`);
  process.exit(1);
}

if (count < BASELINE) {
  console.error(
    `Prompt-authority ratchet: ${count} legacy call sites remain, baseline is ${BASELINE}.\n` +
      `Progress — now lower BASELINE in scripts/check-prompt-authority.mjs to ${count} so it cannot go back up.`
  );
  process.exit(1);
}

console.log(`OK: ${count} legacy prompt call sites (baseline ${BASELINE}); none added.`);
