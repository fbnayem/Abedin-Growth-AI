import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import {
  ABSTENTION_REASONS,
  abstain,
  answered,
  describeAbstention,
  isAbstention,
  isAnswered,
  mayActAutonomouslyOn,
  type AbstentionReason,
  type ModelOutcome,
} from '../domain/abstention';

/**
 * S23 — abstention.
 *
 * `safeGenerateJSON` returns `T` whether a model answered or every candidate failed, so a caller
 * could not tell an answer from a substitute. P1.10 made that failure logged and recorded — the
 * observability half. The safety half was never done, and in the live reply composer the
 * consequence was not a fabricated field but a fabricated EMAIL: reaching the fallback dropped
 * through to a hand-written `switch` composing a complete, send-ready message with list pricing
 * quoted from CANONICAL_KNOWLEDGE.
 *
 * And because that same `switch` ran whenever `USE_GENAI_FOR_REPLIES` was not `'true'` — it is
 * `false` in this deployment — the canned template was not a rare fallback. It was the composer.
 */

// ---------------------------------------------------------------------------
// A model that always fails, so the abstention path is exercised without a network call.
// ---------------------------------------------------------------------------
let generateContentImpl: () => Promise<any> = async () => {
  throw new Error('model unavailable');
};

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => generateContentImpl(),
    };
  },
}));

/**
 * The generation flag is mocked rather than set in the environment.
 *
 * `USE_GENAI_FOR_REPLIES` is `false` in this deployment and must stay that way; these tests need
 * to reach the code path that runs when it is on, without turning it on anywhere real.
 */
let generationEnabled = false;
vi.mock('../config/safeMode', async () => {
  const actual = await vi.importActual<typeof import('../config/safeMode')>('../config/safeMode');
  return { ...actual, isGenerationEnabled: () => generationEnabled };
});

const { generateJsonOrAbstain, safeGenerateJSON } = await import('../geminiClient');
const { composeAutonomousSalesReply, determineNextBestAction, UNASSESSED_PURCHASE_READINESS, UNASSESSED_MEETING_READINESS } =
  await import('../agents/salesDecisionEngine');
const { extractAndSynthesizeMemory } = await import('../agents/conversationMemoryAgent');
const { evaluateEmailUnderstandingRuleBased } = await import('../agents/salesDecisionEngine');
const { BuyingStage } = await import('../../shared/domain/models');

const identity = {
  contactId: 'ct_c1_abc123',
  resolutionMethod: 'EXACT_EMAIL' as any,
  email: 'alice@clinic.example',
  name: 'Alice Smith',
  company: 'Clinic Example',
  domain: 'clinic.example',
} as any;

const composerInput = (text = 'Does it integrate with our existing phone system?') => {
  const understanding = evaluateEmailUnderstandingRuleBased(text);
  return {
    organizationId: 'org_1',
    identity,
    emailUnderstanding: understanding,
    nextBestAction: determineNextBestAction(
      understanding,
      BuyingStage.DISCOVERY,
      UNASSESSED_PURCHASE_READINESS,
      UNASSESSED_MEETING_READINESS
    ),
    buyingStage: BuyingStage.DISCOVERY,
    rawInboundText: text,
    knownRelevantFacts: [] as string[],
  };
};

const conversationFixture = () =>
  ({
    id: 'conv_1',
    contactName: 'Alice Smith',
    contactEmail: 'alice@clinic.example',
    companyName: 'Clinic Example',
    category: 'CUSTOMER',
    thread: [
      {
        id: 'msg_1',
        sender: 'PROSPECT',
        subject: 'Re: hello',
        bodyText: "Hi - I'm away Thursday but saw the demo link. What does it cost?",
        sentAt: '2026-09-07T10:00:00.000Z',
      },
    ],
  }) as any;

// ===========================================================================
describe('the vocabulary', () => {
  it('ONLY AN ANSWER PERMITS AUTONOMOUS ACTION', () => {
    expect(mayActAutonomouslyOn(answered({ a: 1 }))).toBe(true);
    for (const reason of ABSTENTION_REASONS) {
      expect(mayActAutonomouslyOn(abstain(reason, 'x')), reason).toBe(false);
    }
  });

  it('the reason list is not empty, so the loop above proves something', () => {
    expect(ABSTENTION_REASONS.length).toBeGreaterThanOrEqual(5);
    expect(ABSTENTION_REASONS).toContain('MODEL_UNAVAILABLE');
    expect(ABSTENTION_REASONS).toContain('GENERATION_DISABLED');
  });

  it('the guards are equalities, not truthiness tests', () => {
    // Without `strict`, TypeScript does not narrow a discriminated union through a negated
    // truthiness test. Three defects on this branch came from assuming it does.
    const src = readFileSync('server/domain/abstention.ts', 'utf8');
    expect(src).toContain('return outcome.abstained === false;');
    expect(src).not.toMatch(/return !outcome\.abstained;/);
  });

  it('isAnswered and isAbstention partition every outcome', () => {
    const outcomes: ModelOutcome<number>[] = [
      answered(1),
      ...ABSTENTION_REASONS.map((r) => abstain(r, 'x')),
    ];
    for (const o of outcomes) {
      expect(isAnswered(o)).toBe(!isAbstention(o));
    }
  });

  it('an abstention describes itself for an operator', () => {
    expect(describeAbstention(abstain('LOW_CONFIDENCE', 'two sources disagreed'))).toBe(
      'LOW_CONFIDENCE: two sources disagreed'
    );
  });

  it('an unknown reason string still refuses', () => {
    expect(mayActAutonomouslyOn(abstain('INVENTED' as AbstentionReason, 'x'))).toBe(false);
  });
});

// ===========================================================================
describe('the model client', () => {
  beforeEach(() => {
    generateContentImpl = async () => {
      throw new Error('model unavailable');
    };
  });

  it('EVERY CANDIDATE FAILING IS AN ABSTENTION, NOT A VALUE', async () => {
    const outcome = await generateJsonOrAbstain<{ a: number }>({
      prompt: 'x',
      agentName: 'test',
    });
    expect(outcome.abstained).toBe(true);
    if (outcome.abstained === true) {
      expect(outcome.reason).toBe('MODEL_UNAVAILABLE');
      // The detail names what was tried, so a run log entry explains itself.
      expect(outcome.detail).toContain('candidate model');
    }
  });

  it('a real answer comes back as Answered, carrying the parsed value', async () => {
    generateContentImpl = async () => ({ text: '{"a":7}' });
    const outcome = await generateJsonOrAbstain<{ a: number }>({ prompt: 'x', agentName: 'test' });
    expect(outcome.abstained).toBe(false);
    if (outcome.abstained === false) expect(outcome.value).toEqual({ a: 7 });
  });

  it('an empty response body is not an answer', async () => {
    // Both spellings: whitespace, and genuinely empty. The whitespace case alone left the
    // `if (rawText.trim())` guard mutable — removing it still abstained, because the JSON
    // extractor threw on the whitespace and the throw was caught. An empty string does not
    // throw, so without the guard it would return `answered(null)`: a null presented as an
    // answer, which is exactly the conflation this whole change exists to remove.
    for (const text of ['   ', '', '\n\t ']) {
      generateContentImpl = async () => ({ text });
      const outcome = await generateJsonOrAbstain({ prompt: 'x', agentName: 'test' });
      expect(outcome.abstained, JSON.stringify(text)).toBe(true);
    }
  });

  it('A NULL PARSE IS NOT AN ANSWER EITHER', async () => {
    generateContentImpl = async () => ({ text: 'not json at all' });
    const outcome = await generateJsonOrAbstain({ prompt: 'x', agentName: 'test' });
    expect(outcome.abstained).toBe(true);
  });

  it('THE LEGACY WRAPPER STILL RETURNS fallbackData — that is the shape S23 objects to', async () => {
    // Kept deliberately, so a mechanical migration of a dozen agents does not ride along with a
    // safety fix. The ratchet is what stops it spreading.
    const value = await safeGenerateJSON<{ a: number }>({
      prompt: 'x',
      agentName: 'test',
      fallbackData: { a: -1 },
    });
    expect(value).toEqual({ a: -1 });
  });

  it('the wrapper returns the real value when there is one', async () => {
    generateContentImpl = async () => ({ text: '{"a":7}' });
    expect(
      await safeGenerateJSON<{ a: number }>({ prompt: 'x', agentName: 'test', fallbackData: { a: -1 } })
    ).toEqual({ a: 7 });
  });

  it('refusing both forms and neither form is unchanged', async () => {
    await expect(
      generateJsonOrAbstain({ prompt: 'a', systemInstruction: 'b', contents: 'c' })
    ).rejects.toThrow(/not both/);
    await expect(generateJsonOrAbstain({})).rejects.toThrow(/Nothing to send/);
  });
});

// ===========================================================================
describe('nothing hand-writes an email any more', () => {
  const engine = readFileSync('server/agents/salesDecisionEngine.ts', 'utf8');
  // Stripped, because the marker recording the removal necessarily names what was removed, and
  // a negative assertion over comments would forbid explaining the change.
  const memory = stripped('server/agents/conversationMemoryAgent.ts');
  const memoryRaw = readFileSync('server/agents/conversationMemoryAgent.ts', 'utf8');

  it('THE TEMPLATE SWITCH IS GONE FROM THE LIVE COMPOSER', () => {
    for (const gone of [
      'CANONICAL_KNOWLEDGE.pricing.standardPackage',
      'case "SEND_BOOKING_CTA"',
      'case "PROVIDE_TECHNICAL_EXPLANATION"',
      'sub-500ms voice turnaround',
      'Nayem Abedin · Abedin Tech',
    ]) {
      expect(engine, gone).not.toContain(gone);
    }
  });

  it('the two dead composers with fabricated bodies are gone', () => {
    // Both had ZERO callers and both passed a complete, send-ready email as `fallbackData`,
    // then used it a second time as `aiResp.body || fallbackBody`.
    expect(memory).not.toContain('generateMemoryAwareReply');
    expect(memory).not.toContain('generateMemoryAwareFollowUp');
    expect(memory).not.toContain('£5,040/month');
    expect(memory).not.toContain('meet.google.com/abn-vce-demo');
    // and the live one is untouched
    expect(memory).toContain('export async function extractAndSynthesizeMemory');
    // The removal is recorded rather than silent: a reader who greps for the old name should
    // find out what happened to it, not conclude the file never had one.
    expect(memoryRaw).toContain('two dead reply composers removed here');
  });

  it('THE AGENT THAT FABRICATED A POLICY APPROVAL IS GONE', () => {
    // `inboxAgent.processConversationThread` had zero callers and its fallback invented an
    // intent, a confidence of 0.88, the questions the customer had supposedly asked, a complete
    // draft, and `policyStatus: "ALLOW"` — a policy decision, manufactured for a model that
    // never ran.
    expect(existsSync('server/agents/inboxAgent.ts')).toBe(false);
  });

  it('no fabricated confidence survives in an agent fallback', () => {
    // A confidence number is a claim about how much a model believed its own answer. Inventing
    // one for an answer no model produced is the §23 defect in a single field.
    for (const file of ['server/agents/conversationMemoryAgent.ts', 'server/agents/salesDecisionEngine.ts']) {
      const src = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(src, file).not.toMatch(/fallbackData:[\s\S]{0,400}?confidence:\s*[0-9.]+/);
    }
  });
});

// ===========================================================================
describe('the live composer abstains', () => {
  const engine = stripped('server/agents/salesDecisionEngine.ts');
  const pipeline = stripped('server/services/inboundPipeline.ts');

  it('it calls the abstaining client, not the substituting one', () => {
    expect(engine).toContain('await generateJsonOrAbstain<{ subject: string; body: string }>');
    expect(engine).not.toContain('await safeGenerateJSON');
  });

  it('generation disabled is an abstention, not a different way of composing', () => {
    expect(engine).toContain('isGenerationEnabled() === false');
    expect(engine).toContain("'GENERATION_DISABLED'");
  });

  it('the flag is read through the config module, not straight from the environment', () => {
    // P0.2: a direct `process.env` read at decision time is how the enforcement point and the
    // operator display came to disagree in the first place.
    expect(engine).not.toContain('process.env.USE_GENAI_FOR_REPLIES');
    expect(readFileSync('server/config/safeMode.ts', 'utf8')).toContain(
      'export function isGenerationEnabled()'
    );
  });

  it('an unusable answer is an abstention too', () => {
    expect(engine).toContain("'MODEL_RETURNED_NOTHING_USABLE'");
  });

  it('an abstained draft is ALSO stopped by the shared suppression predicate', () => {
    // Belt and braces: `abstainedReply` forces NO_REPLY so the draft is stopped even by a
    // caller that ignores the `abstention` field entirely.
    expect(engine).toContain('nextBestAction: "NO_REPLY" as const');
  });

  it('ABSTENTION IS NOT SUPPRESSION — the pipeline reports them separately', () => {
    // A suppressed reply is a decision. An abstention is the absence of one. Reporting them
    // under one disposition hides a total model outage inside the ordinary suppression count.
    expect(pipeline).toContain('if (draft.abstention !== undefined)');
    expect(pipeline).toContain("disposition: 'ABSTAINED'");
    const abstainAt = pipeline.indexOf('if (draft.abstention !== undefined)');
    const suppressAt = pipeline.indexOf('if (suppressesReply(draft.replyPlan.nextBestAction))');
    expect(abstainAt).toBeGreaterThan(-1);
    expect(suppressAt).toBeGreaterThan(abstainAt);
  });
});

// ===========================================================================
describe('the composer and the extractor, run', () => {
  beforeEach(() => {
    generationEnabled = false;
    generateContentImpl = async () => {
      throw new Error('model unavailable');
    };
  });
  afterEach(() => {
    generationEnabled = false;
  });

  it('generation disabled -> GENERATION_DISABLED, and no model is called', async () => {
    let called = false;
    generateContentImpl = async () => {
      called = true;
      return { text: '{}' };
    };
    const draft = await composeAutonomousSalesReply(composerInput());
    expect(draft.abstention?.reason).toBe('GENERATION_DISABLED');
    expect(called).toBe(false);
  });

  it('generation enabled, model answers -> a real reply', async () => {
    generationEnabled = true;
    generateContentImpl = async () => ({ text: '{"subject":"Re: hi","body":"<p>Yes it does.</p>"}' });
    const draft = await composeAutonomousSalesReply(composerInput());
    expect(draft.abstention).toBeUndefined();
    expect(draft.body).toContain('Yes it does');
  });

  it('generation enabled, every model fails -> MODEL_UNAVAILABLE and an empty body', async () => {
    generationEnabled = true;
    const draft = await composeAutonomousSalesReply(composerInput());
    expect(draft.abstention?.reason).toBe('MODEL_UNAVAILABLE');
    expect(draft.body).toBe('');
  });

  it('AN ANSWER WITH AN EMPTY BODY IS NOT SENT', async () => {
    // Source-asserting the reason string survived a mutation that disabled this guard, because
    // the string stayed in the file inside an unreachable branch.
    generationEnabled = true;
    generateContentImpl = async () => ({ text: '{"subject":"Re: hi","body":"   "}' });
    const draft = await composeAutonomousSalesReply(composerInput());
    expect(draft.abstention?.reason).toBe('MODEL_RETURNED_NOTHING_USABLE');
    expect(draft.body).toBe('');
    expect(draft.replyPlan.nextBestAction).toBe('NO_REPLY');
  });

  it('an answer missing the body field entirely is also refused', async () => {
    generationEnabled = true;
    generateContentImpl = async () => ({ text: '{"subject":"Re: hi"}' });
    const draft = await composeAutonomousSalesReply(composerInput());
    expect(draft.abstention?.reason).toBe('MODEL_RETURNED_NOTHING_USABLE');
  });

  it('THE EXTRACTOR RETURNS AN EMPTY MEMORY, NOT A PLAUSIBLE ONE', async () => {
    // The customer wrote "I'm away Thursday but saw the demo link". The old fallback turned
    // that into an AGREED TIME SLOT of Thursday 2:30 PM, a COMMITMENT to a Meet link we never
    // sent, a RESOLVED OBJECTION nobody raised, and a sentiment of HIGHLY_INTERESTED —
    // 11 durable facts, measured.
    const memory = await extractAndSynthesizeMemory(conversationFixture());
    expect(memory.abstention).toBeDefined();
    expect(memory.abstention!.reason).toBe('MODEL_UNAVAILABLE');
    expect(memory.agreedTimeSlots).toEqual([]);
    expect(memory.commitmentsMade).toEqual([]);
    expect(memory.objectionsResolved).toEqual([]);
    expect(memory.keyPainPoints).toEqual([]);
    expect(memory.prospectSentiment).toBe('UNASSESSED');
  });

  it('a model answer is taken as given, including its empty lists', async () => {
    generateContentImpl = async () =>
      ({ text: '{"keyPainPoints":["missed calls"],"commitmentsMade":[],"prospectSentiment":"SKEPTICAL"}' });
    const memory = await extractAndSynthesizeMemory(conversationFixture());
    expect(memory.abstention).toBeUndefined();
    expect(memory.keyPainPoints).toEqual(['missed calls']);
    // The empty list is the answer. Substituting for it is how the inventions got in.
    expect(memory.commitmentsMade).toEqual([]);
    expect(memory.prospectSentiment).toBe('SKEPTICAL');
  });

  it('a sentiment outside the union becomes UNASSESSED, not the optimistic member', async () => {
    generateContentImpl = async () => ({ text: '{"prospectSentiment":"VERY_KEEN_INDEED"}' });
    const memory = await extractAndSynthesizeMemory(conversationFixture());
    expect(memory.prospectSentiment).toBe('UNASSESSED');
  });
});

// ===========================================================================
describe('the memory extractor stops inventing what a customer agreed to', () => {
  /**
   * The worst instance in the repository, because these values do not stop at one email. The
   * pipeline passes this memory to `observationsFromMemory` and then to `recordFacts`, so each
   * invention became a durable FACT with provenance pointing at a real customer message — and
   * every later prompt read it back as something the customer had said.
   */
  const memory = stripped('server/agents/conversationMemoryAgent.ts');
  const pipeline = stripped('server/services/inboundPipeline.ts');

  it('THE SUBSTRING HEURISTICS ARE GONE', () => {
    // `if (fullText.includes("thursday")) fallbackTimeSlots.push("Thursday 2:30 PM BST")` —
    // a customer writing "I am away Thursday" produced an AGREED TIME SLOT.
    expect(memory).not.toContain('fullText.includes("thursday")');
    expect(memory).not.toContain('Thursday 2:30 PM BST');
    expect(memory).not.toContain('fallbackTimeSlots');
    expect(memory).not.toContain('fallbackCommitments');
  });

  it('NO COMMITMENT, OBJECTION OR SENTIMENT IS INVENTED', () => {
    expect(memory).not.toContain('14-day zero-risk trial');
    expect(memory).not.toContain('Sub-500ms voice response speed and zero double-booking');
    expect(memory).not.toContain('Dropped phone calls during busy clinic hours');
    // The most optimistic member of the union was the default for any thread with an inbound
    // message. A conversation nothing had read was recorded as HIGHLY_INTERESTED.
    expect(memory).not.toMatch(/prospectMsgs\.length > 0 \? "HIGHLY_INTERESTED"/);
  });

  it('an empty answer is an ANSWER, not a cue to substitute', () => {
    // `aiMemory.x.length > 0 ? aiMemory.x : fallback.x` is what made the inventions
    // unavoidable: an empty list from the model means "there were none", and replacing it with
    // a plausible substitute is an absence of evidence becoming a positive claim (§14).
    expect(memory).not.toMatch(/aiMemory\.\w+ && aiMemory\.\w+\.length > 0 \?/);
    expect(memory).toContain('const list = (value: unknown): string[] =>');
  });

  it('an unrecognised sentiment is UNASSESSED, not the most optimistic member', () => {
    expect(memory).toContain('SENTIMENTS.includes(aiMemory.prospectSentiment as any)');
    expect(memory).toContain(": 'UNASSESSED',");
  });

  it('the extractor abstains rather than returning a fabricated memory', () => {
    expect(memory).toContain('const outcome = await generateJsonOrAbstain<Partial<ConversationMemory>>');
    expect(memory).toContain('if (outcome.abstained === true)');
    expect(memory).toContain('abstention: { reason: outcome.reason, detail: outcome.detail }');
  });

  it('AN ABSTAINED EXTRACTION RECORDS NO FACTS', () => {
    // The whole point. A fact derived from a memory no model produced has a source that does
    // not exist, and it re-enters every later prompt as evidence.
    expect(pipeline).toContain('memory.abstention !== undefined');
    expect(pipeline).toMatch(/memory\.abstention !== undefined\s*\n\s*\?\s*\[\]/);
  });

  it('the prompt no longer supplies the fabrications as examples', () => {
    // The few-shot examples were the same claims the fallback invented — including a specific
    // Meet URL and a named trial offer — which primes a model to extract exactly those.
    const raw = readFileSync('server/agents/conversationMemoryAgent.ts', 'utf8');
    expect(raw).not.toContain('meet.google.com/abn-vce-demo');
    expect(raw).toContain('An empty list is a correct answer and is expected.');
  });
});

// ===========================================================================
describe('the ratchet', () => {
  it('exists, is registered in the gate, and states a baseline', () => {
    const guard = readFileSync('scripts/check-abstention-ratchet.mjs', 'utf8');
    expect(guard).toMatch(/^const BASELINE = \d+;$/m);
    const pkg = readFileSync('package.json', 'utf8');
    expect(pkg).toContain('check-abstention-ratchet.mjs');
  });

  it('it counts identifiers, not call shapes', () => {
    // The first version matched a call with an optional type argument and reported 6 sites
    // where grep found 14, because the character class excluded `{`, `}` and `;` — so every
    // call written with an inline object type, which is most of them, was invisible.
    const guard = readFileSync('scripts/check-abstention-ratchet.mjs', 'utf8');
    expect(guard).toContain('const IDENTIFIER = /\\bsafeGenerateJSON\\b/g;');
  });
});

function stripped(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
