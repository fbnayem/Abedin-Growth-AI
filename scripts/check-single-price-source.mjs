#!/usr/bin/env node
/**
 * P1.7 guardrail — a price is written down in one place.
 *
 * The price of the product was in at least eleven files as prose, and they disagreed. "Growth
 * Tier" cost £499/mo with 2,500 minutes in one file and £599/mo with 3,000 minutes in the
 * company-brain document that feeds every outbound prompt, while the contract a customer signs
 * said £499.00. A wrong price is not a display bug — it is a commercial commitment made in
 * writing to a customer.
 *
 * This forbids a currency literal anywhere except the price book itself. It is deliberately
 * blunt: any figure that is genuinely not our price (a customer's own fee in a demo transcript,
 * an approved ROI claim) belongs behind a named allowance below, so each exception is a decision
 * somebody made rather than a hole nobody noticed.
 *
 * Comments are stripped first. Three guardrails on this branch shipped unable to tell a call
 * site from a description of one; this one is verified against that case.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN = ['server', 'src', 'shared'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'tests', '__tests__']);

/** The one file permitted to contain a price. */
const PRICE_BOOK = 'shared/domain/pricing.ts';

/**
 * Figures that are money but are not our price, each with the reason it is allowed.
 * Adding to this list is how an exception becomes a decision instead of a hole.
 */
const ALLOWED = [
  {
    file: 'server/dataStore.ts',
    reason:
      'Seeded demo conversations and briefs quote figures inside simulated customer emails ' +
      'and ROI narratives. These are fixture content, not prices we offer.',
  },
  {
    file: 'server/seedLeadsGenerator.ts',
    reason: 'Generated demo outreach copy in seed fixtures.',
  },
  {
    file: 'src/components/LiveMeetingRoomModal.tsx',
    reason:
      'Contains a simulated call transcript in which a CLINIC quotes its own consultation fee ' +
      'to a patient. Third-party content. Every price OF OURS in this file renders from the ' +
      'price book, which server/tests/pricing.invariant.test.ts asserts separately.',
  },
  {
    file: 'server/agents/pitchBattleAgent.ts',
    reason: 'Competitor cost comparison in pitch copy, not our price.',
  },
  {
    file: 'server/agents/conversationMemoryAgent.ts',
    reason: 'Few-shot example text inside a prompt. Tracked for the P1.10 migration.',
  },
  {
    file: 'server/agents/multiAgentReplySystem.ts',
    reason: 'Few-shot example text inside prompts. Tracked for the P1.10 migration.',
  },
  {
    file: 'server/agents/salesDecisionEngine.ts',
    reason: 'Few-shot example text inside prompts. Tracked for the P1.10 migration.',
  },
  {
    file: 'server/agents/salesEngineTestMatrix.ts',
    reason: 'Test fixtures containing simulated prospect objections that quote a price back.',
  },
  {
    file: 'src/components/AddInvestorModal.tsx',
    reason: "An investor's typical cheque size. Their figure, not our price.",
  },
  {
    file: 'src/components/MissedMeetingRecoveryModal.tsx',
    reason:
      'Estimated lost-revenue figures in recovery copy. ROI claims, not prices — and ' +
      'ungrounded ones: they are computed from "average dental clinic metrics" that no source ' +
      'in this repository provides. Tracked for P1.8.',
  },
  {
    file: 'src/components/SequenceCadenceViewer.tsx',
    reason: 'Missed-call revenue estimate in sequence copy. An ROI claim, not a price.',
  },
  {
    file: 'src/pages/AnalyticsView.tsx',
    reason:
      'A hardcoded £7,200 revenue figure on the analytics dashboard. This is not a price, but ' +
      'it IS a fabricated metric presented as measured — S27 and P1.13 territory, not P1.7. ' +
      'Recorded here so it is not lost.',
  },
];

const ALLOWED_FILES = new Map(ALLOWED.map((a) => [a.file.replace(/\//g, sep()), a.reason]));

function sep() {
  return process.platform === 'win32' ? '\\' : '/';
}

/** A currency symbol followed by a digit. */
const PRICE_LITERAL = /£\s?\d/g;

/**
 * S25 — MONEY IN MINOR UNITS, WHICH THE `£` DETECTOR ABOVE COULD NOT SEE.
 *
 * `PRICE_LITERAL` caught every prose price and was blind to the only figure in this system that
 * can actually move money: `unit_amount: 500000` in `stripe.routes.ts` — a hardcoded USD $5,000
 * for a product priced everywhere else at £499/mo, in a currency `pricing.ts` does not even
 * model, since `CURRENCIES` is `['GBP']`.
 *
 * A control that catches the documentation and misses the live path is the shape this audit
 * keeps finding, and it was in the guardrail itself.
 *
 * So this looks for the field names a payment provider charges on, carrying a numeric LITERAL.
 * `unit_amount: priced.price.minorUnits` does not match, because that is the amount arriving
 * from configuration — which is the fix, not the defect.
 *
 * Three digits or more: `quantity: 1` and `attempts: 2` are not money, and a rule that fired on
 * them would be turned off within a week.
 */
const MINOR_UNIT_LITERAL = /\b(unit_amount|unitAmount|minorUnits|amount_?[a-z]*)\s*:\s*\d{3,}/gi;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function collect(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = [];
for (const dir of SCAN) collect(join(ROOT, dir), files);

const violations = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  if (rel === PRICE_BOOK.replace(/\//g, sep())) continue;
  if (ALLOWED_FILES.has(rel)) continue;

  const source = stripComments(readFileSync(file, 'utf8'));
  for (const pattern of [PRICE_LITERAL, MINOR_UNIT_LITERAL]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length;
      const text = source.split('\n')[line - 1] ?? '';
      violations.push({ file: rel, line, snippet: text.trim().slice(0, 100) });
    }
  }
}

/**
 * A SELF-CHECK THAT RUNS THE REAL PATTERNS.
 *
 * The minor-unit rule was added because the existing one could not see the live path. A rule
 * that matches nothing would reproduce that exactly, and would do it silently on a clean tree.
 */
for (const sample of ["unit_amount: 500000, // $5,000.00", 'unitAmount: 49900', 'minorUnits: 49900']) {
  MINOR_UNIT_LITERAL.lastIndex = 0;
  if (!MINOR_UNIT_LITERAL.test(sample)) {
    console.error(`check-single-price-source: SELF-CHECK FAILED — not detected: ${sample}`);
    process.exit(1);
  }
}
for (const sample of [
  'unit_amount: priced.price.minorUnits,',
  'quantity: 1,',
  'attempts: 2,',
  'const minorUnits = Number(rawAmount);',
]) {
  MINOR_UNIT_LITERAL.lastIndex = 0;
  if (MINOR_UNIT_LITERAL.test(sample)) {
    console.error(
      `check-single-price-source: SELF-CHECK FAILED — flagged legitimate code: ${sample}`
    );
    process.exit(1);
  }
}

if (violations.length > 0) {
  console.error('A price is written down outside the price book.\n');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.snippet}\n`);
  }
  console.error(
    `Read it from ${PRICE_BOOK} and render with formatMoney(). If the figure is genuinely not\n` +
      'our price, add the file to the ALLOWED list in this script with the reason — so the\n' +
      'exception is a decision somebody made rather than a hole nobody noticed.\n'
  );
  process.exit(1);
}

console.log(
  `check-single-price-source: ok — no price literal outside ${PRICE_BOOK}, and no money ` +
    `amount as a numeric literal in minor units (${ALLOWED.length} files carry documented ` +
    'non-price figures).'
);
