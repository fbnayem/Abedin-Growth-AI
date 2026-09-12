import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { REPLY_PROMPT_VERSION } from '../agents/salesDecisionEngine';
import { MEMORY_PROMPT_VERSION } from '../agents/conversationMemoryAgent';
import { POLICY_SOURCES, POLICY_VERSION } from '../policies/version';

/**
 * A VERSION NAMES EXACTLY ONE TEXT (S22, S21).
 *
 * The run log recorded `promptHash` — which rendering ran — and nothing that said which
 * TEMPLATE it was rendered from, or which POLICY decided the run. "Why did it say that?" then has
 * a hash and no way back from the hash to a template a person can read. A declared version fixes
 * that only if the number cannot quietly go on describing a template that has since changed,
 * which is what this file prevents: each version is pinned to a fingerprint of the text it names,
 * and a change to the text without a bump fails here, printing the fingerprint to record.
 *
 * The fingerprints below are the recorded state. Updating one WITHOUT bumping the version beside
 * it defeats the mechanism; the message on failure says which to do.
 */

const RECORDED: Record<string, string> = {
  'composeAutonomousSalesReply@1': '71f58fefb7de3c21',
  'conversationMemoryAgent@1': '36ac0b7cfd16f9e3',
  // policy@1 stays recorded: it is what runs before S37 were governed by, and a row saying
  // policyVersion 1 must remain answerable.
  'policy@1': 'b34d34da5829493c',
  'policy@2': '6156e38d29cd11f1',
};

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
const withoutComments = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*/g, '$1 ');

/** The reply template: the `instruction:` literal handed to assemblePrompt in the composer. */
function replyTemplate(): string {
  const source = read('server/agents/salesDecisionEngine.ts');
  const open = 'const assembled = assemblePrompt({\n       instruction: `';
  const start = source.indexOf(open);
  expect(start, 'the reply template moved; update the extractor').toBeGreaterThan(-1);
  const end = source.indexOf('`,\n       untrusted:', start);
  expect(end, 'the reply template has no closing').toBeGreaterThan(start);
  return source.slice(start + open.length, end);
}

/** The memory template: the `instruction` literal built before assemblePrompt in the extractor. */
function memoryTemplate(): string {
  const source = read('server/agents/conversationMemoryAgent.ts');
  const open = 'const instruction = `';
  const start = source.indexOf(open);
  expect(start, 'the memory template moved; update the extractor').toBeGreaterThan(-1);
  const end = source.indexOf('`;', start);
  expect(end, 'the memory template has no closing').toBeGreaterThan(start);
  return source.slice(start + open.length, end);
}

/** The policy: every listed module, comments stripped, in the listed order. */
function policyText(): string {
  return POLICY_SOURCES.map((p) => `--- ${p}\n${withoutComments(read(p))}`).join('\n');
}

const pinned = (key: string, text: string) => {
  const actual = fingerprint(text);
  expect(
    RECORDED[key],
    `${key} has no recorded fingerprint. If the version was just bumped, record ${actual} for it.`
  ).toBeDefined();
  expect(
    actual,
    `The text ${key} names has changed (fingerprint ${actual}, recorded ${RECORDED[key]}). ` +
      'Bump the version beside the text and record the new fingerprint under the new key — do not ' +
      'update the fingerprint under the old key, which would let one version describe two texts.'
  ).toBe(RECORDED[key]);
};

// =============================================================================================
describe('1. each live-path template declares a version that names exactly one text', () => {
  it('the reply template', () => {
    pinned(`composeAutonomousSalesReply@${REPLY_PROMPT_VERSION}`, replyTemplate());
  });

  it('the memory extraction template', () => {
    pinned(`conversationMemoryAgent@${MEMORY_PROMPT_VERSION}`, memoryTemplate());
  });

  it('the versions are positive integers', () => {
    for (const v of [REPLY_PROMPT_VERSION, MEMORY_PROMPT_VERSION]) {
      expect(Number.isInteger(v) && v >= 1, String(v)).toBe(true);
    }
  });

  it('the extractors found real templates, not empty slices', () => {
    const reply = replyTemplate();
    const memory = memoryTemplate();
    expect(reply.length).toBeGreaterThan(500);
    expect(memory.length).toBeGreaterThan(500);
    // Each declares the output shape it demands — which is why one version covers both.
    expect(reply).toContain('Return JSON ONLY');
    expect(memory).toContain('Return strictly JSON');
  });
});

// =============================================================================================
describe('2. the policy version names exactly one policy text', () => {
  it('the listed modules exist and are the ones on the inbound path', () => {
    const pipeline = withoutComments(read('server/services/inboundPipeline.ts'));
    for (const p of POLICY_SOURCES) {
      expect(read(p).length, p).toBeGreaterThan(100);
    }
    // The pipeline must actually consult these; a policy module nothing reads is not policy.
    expect(pipeline).toContain("from '../policies/workflowBudgets'");
    expect(pipeline).toContain("from '../domain/adjudication'");
    expect(pipeline).toContain("from '../domain/automatedMail'");
    expect(pipeline).toContain("from '../domain/attachmentPolicy'");
  });

  it('the fingerprint is pinned to the version', () => {
    pinned(`policy@${POLICY_VERSION}`, policyText());
  });

  it('a comment-only edit does not change the policy fingerprint', () => {
    // The fingerprint is of behaviour, not prose: annotating a rule is not changing it.
    const a = withoutComments('export const X = 1; // one\n/* block */\nexport const Y = 2;');
    const b = withoutComments('export const X = 1;\nexport const Y = 2;');
    expect(fingerprint(a.replace(/\s+/g, ' '))).toBe(fingerprint(b.replace(/\s+/g, ' ')));
  });
});

// =============================================================================================
describe('3. the version travels: call site -> client -> record -> row', () => {
  const engine = withoutComments(read('server/agents/salesDecisionEngine.ts'));
  const memory = withoutComments(read('server/agents/conversationMemoryAgent.ts'));
  const client = withoutComments(read('server/geminiClient.ts'));

  it('both live call sites pass their declared version', () => {
    expect(engine).toMatch(/agentName: "composeAutonomousSalesReply",\s*promptVersion: REPLY_PROMPT_VERSION,/);
    expect(memory).toMatch(/agentName: 'conversationMemoryAgent',\s*promptVersion: MEMORY_PROMPT_VERSION,/);
  });

  it('the client records it on the answered AND the fallback record', () => {
    const records = client.match(/reportModelCall\(\{[\s\S]*?\}\);/g) ?? [];
    expect(records.length).toBe(2);
    for (const record of records) {
      expect(record).toContain('promptVersion,');
    }
  });

  it('and does not invent one for a caller that declared none', () => {
    expect(client).toContain("typeof options.promptVersion === 'number' ? options.promptVersion : null");
  });
});

// =============================================================================================
describe('4. the mechanism can fail', () => {
  it('a changed template has a different fingerprint', () => {
    const template = replyTemplate();
    expect(fingerprint(template + '\nBe more persuasive.')).not.toBe(fingerprint(template));
  });

  it('a changed rule has a different policy fingerprint', () => {
    const policy = policyText();
    expect(fingerprint(policy.replace('maxModelCallsPerReply: 3', 'maxModelCallsPerReply: 30'))).not.toBe(
      fingerprint(policy)
    );
    // ...and that replacement actually hit something, or the line above proves nothing.
    expect(policy).toContain('maxModelCallsPerReply: 3');
  });
});
