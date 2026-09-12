/**
 * S22 / S21 — the policy version a run log records.
 *
 * "Which policy governed this run" had no answer. The rules are code, and the build SHA
 * identifies all of the code at once — too coarse, since a reply can be governed by the same
 * rules across a hundred commits that touched nothing near them. This number changes when the
 * rules do, and `promptVersions.invariant.test.ts` makes that mechanical: it fingerprints the
 * modules listed below with comments stripped, and fails when they change while this number
 * does not. Bumping it is then a decision somebody makes, with the diff in front of them.
 *
 * What counts as the policy is what the inbound pipeline consults to decide WHETHER and HOW a
 * reply is sent: the adjudication verdict rules, the per-reply budget, the safe-mode flags that
 * gate real actions, the automated-mail classifier, and the attachment policy. Data assembly
 * (context bundles, thread resolution, ledgers) is not policy and is not listed. Prompt
 * templates are versioned separately, beside each template.
 */
// 2 — S37: the per-reply cost ceiling is integer cents and enforced from the provider's price
//     table; an unpriced call is partial at the reply and charged the whole ceiling in the
//     tenant ledger. Version 1 had a float in dollars that nothing compared.
export const POLICY_VERSION = 2;

export const POLICY_SOURCES = [
  'server/domain/adjudication.ts',
  'server/policies/workflowBudgets.ts',
  'server/policies/modelPricing.ts',
  'server/config/safeMode.ts',
  'server/domain/automatedMail.ts',
  'server/domain/attachmentPolicy.ts',
] as const;
