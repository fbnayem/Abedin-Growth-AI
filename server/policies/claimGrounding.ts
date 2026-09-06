import { auditPricingClaims } from '../../shared/domain/quote';
import { priceBookAmounts, type Money } from '../../shared/domain/pricing';

export interface GroundingEvidence {
  claim: string;
  sourceKnowledgeId: string;
  confidence: number;
}

/**
 * P1.7 — CLAIM GROUNDING (addendum §25, §24).
 *
 * WHAT WAS WRONG
 * --------------
 * The pricing rule here was the SECOND copy of the defect P1.7 exists to remove:
 *
 *     if (draftBody.includes('price') || draftBody.includes('$') || draftBody.includes('£')) {
 *       if (!draftBody.includes('£499')) {
 *         ungroundedClaims.push('Unapproved pricing claim detected');
 *       }
 *     }
 *
 * It is worse than the auditor's version was, in a specific way. It fires whenever the body
 * mentions a price at all, and it passes as long as `£499` appears SOMEWHERE — so
 * "our price is £299, down from £499" is grounded, and so is "£4,499". It also fires on any
 * draft containing a dollar sign, which includes every draft mentioning a US customer.
 *
 * Two independent price checks that disagree about what "approved pricing" means is how one of
 * them silently stops applying. Both now call the same function.
 */
export class ClaimGroundingEngine {
  /**
   * Verify that claims in a draft are grounded.
   *
   * `permittedAmounts` defaults to the price book. A caller with a customer-specific quote
   * passes that customer's quotable amounts instead, so a list price stated over a negotiated
   * one is ungrounded here for the same reason it is in the auditor.
   */
  async verifyClaims(
    draftBody: string,
    permittedAmounts: readonly Money[] = priceBookAmounts(),
    groundedNonPriceAmounts: readonly Money[] = []
  ): Promise<{ isGrounded: boolean; ungroundedClaims: string[] }> {
    const ungroundedClaims: string[] = [];

    for (const finding of auditPricingClaims(draftBody, permittedAmounts, groundedNonPriceAmounts)) {
      ungroundedClaims.push(finding.message);
    }

    // NOT IMPLEMENTED, and said so rather than implied by an empty result: extracting the
    // non-price claims from a draft and matching them against the knowledge base is real work
    // (§20 provenance gives it something to match against, but nothing calls it yet). A
    // grounding engine that checks only prices and reports `isGrounded: true` would tell a
    // caller that every capability, integration and SLA claim in the draft had been verified.
    // The pricing result stands on its own; the rest is absent and named as absent.
    return {
      isGrounded: ungroundedClaims.length === 0,
      ungroundedClaims,
    };
  }

  /**
   * What this engine does NOT check, for callers deciding how much weight to give a pass.
   *
   * Exposed as data rather than left in a comment so an operator-facing surface can show it,
   * and so a future caller cannot mistake a pass for a full grounding verdict.
   */
  static readonly UNCHECKED_CLAIM_TYPES: readonly string[] = Object.freeze([
    'Capability claims (what the product can do)',
    'Integration claims (which systems it connects to)',
    'Performance and SLA claims (latency, uptime)',
    'ROI and benchmark figures',
    'Compliance claims (HIPAA, GDPR, SOC-2)',
  ]);
}
