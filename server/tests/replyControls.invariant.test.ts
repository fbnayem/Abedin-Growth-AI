import { describe, it, expect } from 'vitest';
import {
  composeAutonomousSalesReply,
  determineNextBestAction,
  evaluateEmailUnderstandingRuleBased,
  UNASSESSED_MEETING_READINESS,
  UNASSESSED_PURCHASE_READINESS,
} from '../agents/salesDecisionEngine';
import {
  ACTION_SUPPRESSES_REPLY,
  BuyingStage,
  suppressesReply,
  type NextBestActionType,
} from '../../shared/domain/models';
import { extractMoneyLiterals, PRICE_BOOK, priceBookAmounts } from '../../shared/domain/pricing';
import { auditPricingClaims } from '../../shared/domain/quote';

/**
 * Four controls that reported success without checking anything.
 *
 * Each was written down as working — in a comment, a status entry, or a test that asserted the
 * source text contained an identifier. Each is asserted here through its BEHAVIOUR, because
 * three of the four already had a passing test when they were broken.
 */

const ORG = 'org_1';

const identity = {
  contactId: 'ct_c1_abc123',
  resolutionMethod: 'EXACT_EMAIL' as any,
  email: 'alice@clinic.example',
  name: 'Alice Smith',
  company: 'Clinic Example',
  domain: 'clinic.example',
  identityConfidence: 0.9,
};

// ===========================================================================
describe('1. the suppression guard', () => {
  /**
   * The pipeline read:
   *
   *     if (nbaResult.action === 'DO_NOTHING' as any || nbaResult.action === 'SUPPRESS_NO_ACTION' as any)
   *
   * Neither string is a member of NextBestActionType. The guard was dead, so the only branch
   * in the system that says "do not reply" could never fire.
   */

  it('an unsubscribe request suppresses the reply', () => {
    const u = evaluateEmailUnderstandingRuleBased(
      'Please unsubscribe me from this list. Remove me immediately.'
    );
    const nba = determineNextBestAction(
      u,
      BuyingStage.DISCOVERY,
      UNASSESSED_PURCHASE_READINESS,
      UNASSESSED_MEETING_READINESS
    );
    expect(u.isUnsubscribe).toBe(true);
    expect(nba.action).toBe('SUPPRESS');
    // The measured regression: this was `false`, so the prospect was sent a sales reply.
    expect(suppressesReply(nba.action)).toBe(true);
  });

  it('an out-of-office autoresponder suppresses the reply', () => {
    const u = evaluateEmailUnderstandingRuleBased(
      'I am currently out of the office until 15 September with no access to email.'
    );
    const nba = determineNextBestAction(
      u,
      BuyingStage.DISCOVERY,
      UNASSESSED_PURCHASE_READINESS,
      UNASSESSED_MEETING_READINESS
    );
    expect(u.isOutOfOffice).toBe(true);
    expect(nba.action).toBe('NO_REPLY');
    expect(suppressesReply(nba.action)).toBe(true);
  });

  it('an ordinary pricing enquiry is NOT suppressed', () => {
    // The fix must not become "suppress everything", which would pass every test above.
    const u = evaluateEmailUnderstandingRuleBased('Hi, could you tell me about your pricing?');
    const nba = determineNextBestAction(
      u,
      BuyingStage.DISCOVERY,
      UNASSESSED_PURCHASE_READINESS,
      UNASSESSED_MEETING_READINESS
    );
    expect(suppressesReply(nba.action)).toBe(false);
  });

  it('the two literals the dead guard compared against are not members of the union', () => {
    expect(Object.prototype.hasOwnProperty.call(ACTION_SUPPRESSES_REPLY, 'DO_NOTHING')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(ACTION_SUPPRESSES_REPLY, 'SUPPRESS_NO_ACTION')).toBe(
      false
    );
  });

  it('an unrecognised action suppresses — sending is the permission (§14)', () => {
    for (const unknown of ['DO_NOTHING', 'SUPPRESS_NO_ACTION', 'MAYBE', '', 'no_reply']) {
      expect(suppressesReply(unknown)).toBe(true);
    }
  });

  it('a non-string action suppresses rather than throwing or sending', () => {
    for (const bad of [undefined, null, 0, {}, [], true]) {
      expect(suppressesReply(bad)).toBe(true);
    }
  });

  it('the map classifies every member of the union, so a new one cannot default to sending', () => {
    // If this list and the type drift, the Record's own type check fails at compile time.
    // Asserted at runtime too, because the compile-time check is invisible in a test report.
    const classified = Object.keys(ACTION_SUPPRESSES_REPLY);
    expect(classified).toContain('NO_REPLY');
    expect(classified).toContain('SUPPRESS');
    expect(classified.length).toBe(20);
    for (const value of Object.values(ACTION_SUPPRESSES_REPLY)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('the map is frozen, so a caller cannot turn a suppression into a send', () => {
    expect(Object.isFrozen(ACTION_SUPPRESSES_REPLY)).toBe(true);
  });

  it('exactly the two suppressing actions suppress', () => {
    const suppressing = (Object.keys(ACTION_SUPPRESSES_REPLY) as NextBestActionType[]).filter(
      (k) => ACTION_SUPPRESSES_REPLY[k]
    );
    expect(suppressing.sort()).toEqual(['NO_REPLY', 'SUPPRESS']);
  });
});

// ===========================================================================
describe('2. the money-extraction regex', () => {
  /**
   * `/£\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?/g` read "£4999" as its first three digits:
   * the grouped alternative matches "499", the comma group matches zero times, the overall
   * match succeeds, and the engine never backtracks into `\d+`. "£4999" and "£499" produced
   * identical output, and 49900 is the price book's £499.00.
   */

  const minor = (text: string) => extractMoneyLiterals(text).map((m) => m.amountMinor);

  it('a four-digit amount is not read as its first three digits', () => {
    expect(minor('£4999')).toEqual([499900]);
  });

  it('"£4999" and "£499" are no longer indistinguishable', () => {
    expect(minor('£4999')).not.toEqual(minor('£499'));
  });

  it('a five-digit amount is read in full', () => {
    expect(minor('£12345')).toEqual([1234500]);
    expect(minor('£1000')).toEqual([100000]);
  });

  it('pence on a four-digit amount are not discarded', () => {
    // The old pattern returned [49900] here — it dropped both the leading digit and the pence.
    expect(minor('£4999.50')).toEqual([499950]);
  });

  it('grouped amounts still parse exactly', () => {
    expect(minor('£4,999')).toEqual([499900]);
    expect(minor('£1,234,567')).toEqual([123456700]);
  });

  it('the forms that already worked are unchanged', () => {
    expect(minor('£499')).toEqual([49900]);
    expect(minor('£499.00')).toEqual([49900]);
    expect(minor('£0.12')).toEqual([12]);
    expect(minor('£ 499')).toEqual([49900]);
    expect(minor('£299')).toEqual([29900]);
    expect(minor('we charge £499 or £4,999 setup')).toEqual([49900, 499900]);
  });

  it('a version number is still not an amount', () => {
    expect(minor('v1.2.3 costs £499')).toEqual([49900]);
  });

  it('an amount that cannot be read exactly still surfaces as SOME amount', () => {
    // The failure direction that matters. A malformed "£4,9999" must not vanish into a clean
    // report — it falls back to a shorter match, which is then not in the price book and is
    // flagged. Silence would read as "no price stated".
    expect(minor('£4,9999').length).toBeGreaterThan(0);
    expect(minor('£10.123').length).toBeGreaterThan(0);
  });

  it('...but not as a plausible amount somebody might have approved', () => {
    // Without the `(?!\d)` lookahead "£4,9999" reads as exactly £4,999.00 — a well-formed
    // price that could sit on a real quote and pass an audit. A malformed amount must fail
    // toward "not in the price book", never toward a number that looks legitimate.
    expect(minor('£4,9999')).not.toContain(499900);
    expect(minor('£10.123')).not.toContain(1012);
  });

  it('THE CONSEQUENCE: a ten-times-wrong price no longer passes the pricing audit', () => {
    // This is the test that matters. £499 is the real price; £4999 is ten times it.
    const permitted = priceBookAmounts();
    expect(auditPricingClaims('Our price is £499 per month.', permitted, [])).toHaveLength(0);

    const findings = auditPricingClaims('Our price is £4999 per month.', permitted, []);
    expect(findings.length).toBeGreaterThan(0);
  });

  it('the price book still contains the amount the audit is checking against', () => {
    // Guards against the previous test passing because the price book emptied.
    expect(PRICE_BOOK.length).toBeGreaterThan(0);
    expect(priceBookAmounts().some((m) => m.amountMinor === 49900)).toBe(true);
  });
});

// ===========================================================================
describe('3. a quote lookup that fails blocks a pricing reply', () => {
  /**
   * `quoteLookupFailed` was assigned, logged, and never read again. The comment above it said
   * a lookup failure "BLOCKS rather than silently degrading to the default"; nothing blocked.
   * The guarding test was `expect(source).toContain('quoteLookupFailed')`, which a write-only
   * variable satisfies.
   *
   * S50 — this used to say:
   *
   *     "DATABASE_URL is unset in this environment, so getQuotes throws for real —
   *      this exercises the actual failure, not a simulated one."
   *
   * True when it was written, and it made these tests depend on a global environment
   * condition rather than on anything they set. When a database became reachable the lookup
   * started succeeding, the refusal branch stopped being entered, and two of these tests
   * failed — which is the good outcome. Had they been written to pass either way, the
   * control would simply have stopped being covered and nothing would have said so.
   *
   * The failure is now injected through `readQuotes`, so what is exercised is the same
   * branch whether or not a database exists.
   */

  const inputFor = (text: string) => {
    const understanding = evaluateEmailUnderstandingRuleBased(text);
    return {
      organizationId: ORG,
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
      // The lookup fails. Injected rather than arranged by unsetting an environment
      // variable, so this is the same branch on a machine with a database and one without.
      readQuotes: async () => {
        throw new Error('connection refused');
      },
    };
  };

  /** The same input with a lookup that SUCCEEDS and finds nothing — a different thing. */
  const inputWithWorkingLookup = (text: string) => ({
    ...inputFor(text),
    readQuotes: async () => [] as unknown[],
  });

  it('a pricing reply is refused when the quote history cannot be read', async () => {
    const input = inputFor('What does it cost? Please send me your pricing.');
    expect(input.nextBestAction.pricingAllowed).toBe(true);

    const draft = await composeAutonomousSalesReply(input);

    expect(draft.replyPlan.nextBestAction).toBe('NO_REPLY');
    expect(suppressesReply(draft.replyPlan.nextBestAction)).toBe(true);
    expect(draft.body).toBe('');
  });

  it('the refusal says WHY, so it is not indistinguishable from having no quote', async () => {
    const draft = await composeAutonomousSalesReply(
      inputFor('What does it cost? Please send me your pricing.')
    );
    expect(draft.replyPlan.reason).toContain('Refused to state pricing');
    expect(draft.replyPlan.reason).toMatch(/quote|contact/i);
  });

  it('a NON-pricing reply is not stopped by the QUOTE failure', async () => {
    // The block must be scoped. If the plan was never going to state a price, an unreadable
    // quote history costs nothing, and blocking every reply would be its own defect.
    //
    // Migrated 2026-09-07 (S23). This asserted `nextBestAction !== 'NO_REPLY'` and a non-empty
    // body, both of which came from the hand-written template that used to run when generation
    // is disabled. That template is gone, so this input now stops for a DIFFERENT reason —
    // and the distinction is precisely what the test is for. Asserting the reason rather than
    // the action keeps the original claim ("the quote failure is scoped") testable, and would
    // have caught the quote block widening to cover every reply.
    const input = inputFor('Does it integrate with our existing phone system?');
    expect(input.nextBestAction.pricingAllowed).toBe(false);

    const draft = await composeAutonomousSalesReply(input);
    expect(draft.abstention?.reason).toBe('GENERATION_DISABLED');
    expect(draft.replyPlan.reason).not.toContain('Refused to state pricing');
  });

  /**
   * The case the old environment could not produce at all. With DATABASE_URL unset every
   * lookup threw, so "the query ran and this customer has no quote" was unreachable — and it
   * is the ordinary case for almost every customer.
   *
   * It must NOT be refused: a successful lookup returning nothing is an answer.
   */
  it('a lookup that succeeds and finds no quote is not a refusal', async () => {
    const draft = await composeAutonomousSalesReply(
      inputWithWorkingLookup('What does it cost? Please send me your pricing.')
    );
    expect(draft.replyPlan.reason).not.toContain('Refused to state pricing');
    // It still produces no reply here, because generation is disabled in this deployment —
    // a different stop, with a different name, which is the whole point of S23.
    expect(draft.abstention?.reason).toBe('GENERATION_DISABLED');
  });

  it('the PRICING refusal and the abstention are distinguishable', async () => {
    // Both end at NO_REPLY with an empty body, and they are not the same event: one is a
    // §14 refusal to state a price we could not verify, the other is "no model answered".
    // An operator triaging a queue must be able to tell them apart.
    const priced = await composeAutonomousSalesReply(
      inputFor('What does it cost? Please send me your pricing.')
    );
    const plain = await composeAutonomousSalesReply(
      inputFor('Does it integrate with our existing phone system?')
    );

    expect(priced.abstention).toBeUndefined();
    expect(priced.replyPlan.reason).toContain('Refused to state pricing');

    expect(plain.abstention).toBeDefined();
    expect(plain.replyPlan.reason).toContain('Abstained');
  });

  it('a refused pricing reply carries no quotable body a caller could send anyway', async () => {
    const draft = await composeAutonomousSalesReply(
      inputFor('What does it cost? Please send me your pricing.')
    );
    expect(draft.subject).toBe('');
    expect(extractMoneyLiterals(draft.body)).toEqual([]);
  });
});

// ===========================================================================
describe('4. the two price checks agree about what is permitted', () => {
  /**
   * The auditor called `verifyClaims(sanitizedBody)` with one argument, defaulting
   * `permittedAmounts` to the LIST price book, while the check 29 lines earlier used the
   * customer's approved quote. Two price checks over two different permitted sets.
   */

  it('verifyClaims defaults to the list price book when given no permitted set', async () => {
    // The default is not wrong in itself — relying on it at a call site that has computed a
    // narrower set is. This pins the default so the next assertion means something.
    const { ClaimGroundingEngine } = await import('../policies/claimGrounding');
    const engine = new ClaimGroundingEngine();
    const listed = await engine.verifyClaims('Our price is £499 per month.');
    expect(listed.isGrounded).toBe(true);

    const withNarrowerSet = await engine.verifyClaims(
      'Our price is £499 per month.',
      [{ amountMinor: 39900, currency: 'GBP' }],
      []
    );
    // Same text, different permitted set, different verdict — which is exactly why the call
    // site must pass the set it computed rather than letting the default apply.
    expect(withNarrowerSet.isGrounded).toBe(false);
  });

  it('the auditor passes its computed pricing context to the grounding engine', async () => {
    const source = readAuditorSource();
    // Behavioural coverage of this one needs a populated `input.quote`, which nothing produces
    // yet (recorded in the status document). Until then this pins the wiring — and unlike the
    // `quoteLookupFailed` check it asserts the ARGUMENT, not merely that an identifier occurs.
    expect(source).toMatch(
      /verifyClaims\(\s*sanitizedBody,\s*pricingContext\.quotableAmounts,\s*input\.groundedNonPriceAmounts/
    );
    expect(source).not.toMatch(/verifyClaims\(sanitizedBody\)/);
  });
});

// ===========================================================================
describe('5. the pipeline honours suppression at both boundaries', () => {
  /**
   * `processNewEmail` needs a live datastore, so these pin the WIRING rather than run it. They
   * assert the argument the guard is called with, not merely that an identifier occurs
   * somewhere in the file — which is the specific weakness that let `quoteLookupFailed` ship
   * write-only with a passing test.
   */
  const source = readPipelineSource();

  it('the pre-compose guard tests the action through the shared predicate', () => {
    expect(source).toMatch(/if\s*\(suppressesReply\(nbaResult\.action\)\)/);
  });

  it('the dead comparison is gone, casts and all', () => {
    expect(source).not.toContain('DO_NOTHING');
    expect(source).not.toContain('SUPPRESS_NO_ACTION');
  });

  it('a plan that suppresses after composing stops before the outbox write', () => {
    // The prompt-injection branch and the refused-pricing branch both return an empty draft
    // carrying a suppressing action; without this the empty body was queued as an outbox row.
    expect(source).toMatch(/if\s*\(suppressesReply\(draft\.replyPlan\.nextBestAction\)\)/);
  });

  it('the post-compose guard precedes the outbox write, not follows it', () => {
    const guard = source.indexOf('suppressesReply(draft.replyPlan.nextBestAction)');
    const queue = source.indexOf('queueMessage');
    expect(guard).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(queue);
  });
});

function readPipelineSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs');
  return (readFileSync('server/services/inboundPipeline.ts', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function readAuditorSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require('node:fs');
  // Comments stripped first: the comment recording the OLD call contains `verifyClaims(
  // sanitizedBody)` verbatim, and matching prose about the defect would make the check pass
  // or fail for the wrong reason. Caught by this test failing against correct code.
  return (readFileSync('server/agents/independentAuditor.ts', 'utf8') as string)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}
