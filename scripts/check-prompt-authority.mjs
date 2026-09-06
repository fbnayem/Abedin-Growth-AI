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
const BASELINE = 16;

const ROOT = 'server';
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'tests']);

const offenders = [];

function scan(path) {
  const source = readFileSync(path, 'utf8');
  if (!source.includes('safeGenerateJSON')) return;

  const lines = source.split('\n');
  lines.forEach((line, index) => {
    // The legacy form as it is actually written in this codebase: `prompt,` shorthand or
    // `prompt: <expr>` inside the options object.
    if (/^\s*prompt,\s*$/.test(line) || /^\s*prompt:\s*\S/.test(line)) {
      offenders.push({ path: relative(process.cwd(), path), line: index + 1 });
    }
  });
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
