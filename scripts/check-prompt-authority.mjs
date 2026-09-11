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

/**
 * The model-call functions whose options this scans.
 *
 * `safeGenerateJSON` alone, until 2026-09-12. `generateJsonOrAbstain` takes the SAME options —
 * `{ prompt }` or `{ systemInstruction, contents }` — and was invisible here. So converting a
 * call site from the legacy wrapper to the abstaining one, which S23's ratchet asks for, removed
 * it from THIS ratchet while leaving its prompt exactly as legacy as before: the count would have
 * fallen because the detector went blind, not because anything was fixed. Found while converting
 * the company brain, which would have been the first site to disappear that way.
 */
const MODEL_CALLS = ['safeGenerateJSON', 'generateJsonOrAbstain'];

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
 * The character span of each model call, by matching parentheses.
 *
 * The optional generic argument is skipped: most real call sites in this codebase are written
 * `safeGenerateJSON<{ steps?: any[] }>({ prompt, ... })`, and a needle of `safeGenerateJSON(`
 * matches none of them — which made this scanner report ZERO offenders where there were 16.
 */
function callSpansOf(code, needle) {
  const spans = [];
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

/** Every call, to every function that takes these options. */
function callSpans(code) {
  return MODEL_CALLS.flatMap((needle) => callSpansOf(code, needle));
}

// `prompt` as a KEY of the options object: `{ prompt, ... }` shorthand or `{ prompt: expr }`.
//
// Anchoring on the preceding `{` or `,` is what separates a key from a value. Without it,
// `safeGenerateJSON({ contents: prompt, ... })` — the SAFE form, where the untrusted material
// simply lives in a variable called `prompt` — would be reported as a legacy call site.
const LEGACY = /[{,]\s*prompt\s*[,}:]/g;

/**
 * The offset of every legacy `prompt` key inside a model call in `source`.
 *
 * Only a key INSIDE a model call counts. The check is about a model call using the legacy
 * single-string form, not about the word `prompt` appearing in a file — and an object literal
 * passed to something else (a hash, a log record) is neither a model call nor an authority
 * boundary.
 *
 * Pulled out of `scan` so the self-check below runs the real rule rather than a copy of it.
 */
function legacyOffsets(source) {
  if (!MODEL_CALLS.some((name) => source.includes(name))) return { code: '', offsets: [] };
  const code = stripCommentsAndStrings(source);
  const offsets = [];
  for (const [start, end] of callSpans(code)) {
    const segment = code.slice(start, end + 1);
    LEGACY.lastIndex = 0;
    let match;
    while ((match = LEGACY.exec(segment)) !== null) offsets.push(start + match.index);
  }
  return { code, offsets };
}

let filesScanned = 0;

function scan(path) {
  filesScanned++;
  const { code, offsets } = legacyOffsets(readFileSync(path, 'utf8'));
  if (offsets.length === 0) return;

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
  for (const offset of offsets) {
    offenders.push({ path: relative(process.cwd(), path), line: lineOf(offset) });
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

// SELF-CHECK. The rule runs against sources whose answer is known, so a change that blinds it
// fails here rather than turning the ratchet into a count of nothing. Every row was a real
// shape: the nested generic is `conversationMemoryAgent.ts`, and the safe form is the migration
// target.
//
// NOTE, recorded rather than hidden: disabling this self-check is a mutant that SURVIVES the gate
// (measured 2026-09-12), and it is unexpressible against this tree. A self-check is insurance —
// it fires only when the rule itself is broken, so with the rule intact removing it changes no
// outcome. The insured event, the rule going blind to `generateJsonOrAbstain`, was run as its own
// mutant and is KILLED.
const SELF_CHECK = [
  ['safeGenerateJSON({ prompt, fallbackData: {} })', 1],
  ['safeGenerateJSON<{ steps?: any[] }>({ prompt: p, fallbackData: {} })', 1],
  ['generateJsonOrAbstain({ prompt })', 1],
  ['generateJsonOrAbstain<Partial<ConversationMemory>>({ prompt, category: "SMART" })', 1],
  ['generateJsonOrAbstain({ systemInstruction, contents: prompt })', 0],
  ['// generateJsonOrAbstain({ prompt })', 0],
  ['hashPrompt({ prompt: options.prompt })', 0],
];
for (const [source, expected] of SELF_CHECK) {
  const found = legacyOffsets(source).offsets.length;
  if (found !== expected) {
    console.error(
      `check-prompt-authority SELF-CHECK FAILED: ${JSON.stringify(source)} gave ${found} legacy ` +
        `site(s), expected ${expected}. The rule is broken, not the tree clean.`
    );
    process.exit(1);
  }
}

try {
  if (statSync(ROOT).isDirectory()) walk(ROOT);
} catch {
  console.error(`Cannot read ${ROOT}/`);
  process.exit(1);
}

// A broken walk returns a handful of files or none; the tree has over a hundred. The floor sits
// well below that so deleting dead modules never trips it.
const MIN_FILES = 50;
if (filesScanned < MIN_FILES) {
  console.error(
    `check-prompt-authority: only ${filesScanned} files scanned (floor ${MIN_FILES}). The scan is ` +
      'broken, not the tree clean.'
  );
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
  for (const o of offenders) console.error(`  ${o.path}:${o.line}`);
  process.exit(1);
}

console.log(
  `OK: ${count} legacy prompt call sites (baseline ${BASELINE}); none added. ${filesScanned} files scanned.`
);
