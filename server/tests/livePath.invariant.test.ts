import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  composeAutonomousSalesReply,
  determineNextBestAction,
  evaluateEmailUnderstandingRuleBased,
  UNASSESSED_MEETING_READINESS,
  UNASSESSED_PURCHASE_READINESS,
} from '../agents/salesDecisionEngine';
import { BuyingStage } from '../../shared/domain/models';

/**
 * The live inbound drafting path.
 *
 * `server/services/inboundPipeline.ts` called `composeAutonomousSalesReply` with four of its six
 * required fields under names the function does not read, behind an `as any` that stopped the
 * compiler objecting. Measured by calling it with that exact argument object:
 *
 *     TypeError: Cannot read properties of undefined (reading 'contactId')
 *
 * Every inbound email reached that line, threw, and was swallowed by an enclosing
 * `catch (e) { console.error(...) }` — so the pipeline returned as though it had worked while
 * producing no draft and no outbox job. These tests exist so that cannot return silently.
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

/**
 * A NON-PRICING enquiry, deliberately.
 *
 * This used to ask about pricing. Once a failed quote lookup began blocking pricing replies
 * (§14 — we cannot state a price without knowing whether this customer negotiated one, and
 * `getQuotes` throws with DATABASE_URL unset), every test below would have exercised the
 * REFUSAL branch while claiming to test the drafting path — and all but one would still have
 * passed. The tests here are about the composer running at all, so they must reach it.
 */
const NON_PRICING_ENQUIRY = 'Hello, does your system integrate with our existing phone lines?';

const wellFormedInput = () => {
  const understanding = evaluateEmailUnderstandingRuleBased(NON_PRICING_ENQUIRY);
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
    rawInboundText: NON_PRICING_ENQUIRY,
    knownRelevantFacts: [] as string[],
  };
};

describe('the live inbound drafting path', () => {
  // -------------------------------------------------------------------------
  describe('the shape the pipeline actually passes', () => {
    it('produces a draft instead of throwing', async () => {
      // The regression. Before the fix this rejected with a TypeError.
      const draft = await composeAutonomousSalesReply(wellFormedInput());
      expect(draft).toBeTruthy();
      expect(typeof draft.subject).toBe('string');
      expect(typeof draft.body).toBe('string');
      expect(draft.body.length).toBeGreaterThan(0);
    });

    it('the fixture really does reach the drafter, not the pricing refusal', () => {
      // Guards the test above against silently passing through a different branch: if this
      // fixture ever becomes a pricing enquiry again, the quote-lookup block takes over and
      // these tests stop testing the composer.
      expect(wellFormedInput().nextBestAction.pricingAllowed).toBe(false);
    });

    it('the OLD argument object is exactly what the compiler now rejects', () => {
      // Reproduced verbatim from the pre-fix call site. Without `as any` this does not compile,
      // which is the entire point: the cast is what let it ship.
      const oldShape = {
        incomingEmail: 'text',
        latestIntent: 'PRICING_INQUIRY',
        buyingStage: BuyingStage.DISCOVERY,
        nextBestAction: { action: 'REPLY' },
        prospectName: 'alice@clinic.example',
      };
      // @ts-expect-error
      const rejected: Parameters<typeof composeAutonomousSalesReply>[0] = oldShape;
      expect(rejected).toBeDefined();

      // And the fields the function actually reads are absent from it — which is why it threw.
      expect('identity' in oldShape).toBe(false);
      expect('emailUnderstanding' in oldShape).toBe(false);
      expect('rawInboundText' in oldShape).toBe(false);
    });

    it('a missing identity still fails loudly rather than drafting from nothing', async () => {
      // The fix must not become "tolerate undefined". Drafting a sales reply without knowing
      // who it is for is worse than failing.
      await expect(
        composeAutonomousSalesReply({ ...wellFormedInput(), identity: undefined } as any)
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('facts recorded by the pipeline reach the planner', () => {
    it('supplied facts appear in the reply plan', async () => {
      const facts = ['budget: 15000', 'decision_maker: Alice Smith'];
      const draft = await composeAutonomousSalesReply({
        ...wellFormedInput(),
        knownRelevantFacts: facts,
      });
      expect(draft.replyPlan.knownRelevantFacts).toEqual(facts);
    });

    it('no facts means an empty list, not invented ones', async () => {
      // It used to carry two hardcoded sentences about latency and calendar sync for every
      // customer, in a field typed as the facts relevant to THIS conversation.
      const draft = await composeAutonomousSalesReply({ ...wellFormedInput(), knownRelevantFacts: [] });
      expect(draft.replyPlan.knownRelevantFacts).toEqual([]);
      expect(JSON.stringify(draft.replyPlan.knownRelevantFacts)).not.toContain('latency');
    });
  });

  // -------------------------------------------------------------------------
  describe('unassessed readiness is explicit, and never grants permission', () => {
    it('a score of zero cannot clear a threshold', () => {
      expect(UNASSESSED_PURCHASE_READINESS.score).toBe(0);
      expect(UNASSESSED_MEETING_READINESS.score).toBe(0);
    });

    it('an unassessed meeting readiness does not offer a booking', () => {
      // §14: unknown must not default to permission, and offering a meeting is a permission.
      expect(UNASSESSED_MEETING_READINESS.shouldOfferBooking).toBe(false);
    });

    it('both say plainly that nothing assessed them', () => {
      expect(UNASSESSED_PURCHASE_READINESS.reasoning).toContain('not been assessed');
      expect(UNASSESSED_MEETING_READINESS.reasoning).toContain('not been assessed');
    });

    it('they are frozen, so a caller cannot mutate the shared default into permission', () => {
      expect(Object.isFrozen(UNASSESSED_PURCHASE_READINESS)).toBe(true);
      expect(Object.isFrozen(UNASSESSED_MEETING_READINESS)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('the pipeline source', () => {
    const source = readFileSync('server/services/inboundPipeline.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    it('passes the fields the planner reads, with no cast', () => {
      expect(source).toContain('const draft = await composeAutonomousSalesReply({');
      expect(source).toContain('identity,');
      expect(source).toContain('emailUnderstanding: understanding,');
      expect(source).toContain('rawInboundText:');
      expect(source).not.toContain('incomingEmail: email.textBody');
      expect(source).not.toContain('prospectName: email.from');
    });

    it('reads facts back and gives them to the planner', () => {
      // listActiveFacts had ZERO callers: facts were written on every inbound message and read
      // by nothing. The facts now travel inside the context bundle rather than as a bare
      // string[], so the planner gets a manifest and a hash with them (S21).
      expect(source).toContain('listActiveFacts(organizationId, conversationId)');
      expect(source).toContain('facts: activeFactRecords,');
      expect(source).toContain('contextBundle,');
    });

    it('a fact-store failure is reported as UNAVAILABLE, not read as "no facts"', () => {
      // The distinction the whole bundle change exists for: an empty fact list and an
      // unreadable fact store are different states (§14).
      expect(source).toMatch(/catch[\s\S]{0,120}?noteUnavailable\('FACT'/);
      expect(source).toContain("unavailable.push(kind)");
    });

    it('the NBA call no longer passes empty objects behind a cast', () => {
      expect(source).toContain('UNASSESSED_PURCHASE_READINESS');
      expect(source).toContain('UNASSESSED_MEETING_READINESS');
      expect(source).not.toContain('determineNextBestAction(understanding, BuyingStage.DISCOVERY, {} as any, {} as any)');
    });
  });
});
