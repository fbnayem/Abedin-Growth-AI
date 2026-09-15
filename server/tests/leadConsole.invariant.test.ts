import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * WHAT THE CONSOLE IS AND IS NOT ALLOWED TO CLAIM (§8, §14, §26).
 *
 * These read SOURCE, because what is being asserted is an absence: that four specific
 * fabrications are gone and have not reappeared in a neighbouring file. That is the same shape
 * as `fabricatedEngagement.invariant`, and for the same reason — a rendered number that nothing
 * measured is not caught by any test of the thing that was supposed to measure it.
 *
 * THE FOUR
 * --------
 * 1. Three "Discover with AI" modals called an endpoint that answered 501, under a paragraph
 *    claiming every lead was "checked against your company ICP brain, analyzed for phone
 *    reliance and decision-maker seniority, and scored on a 0-100 scale". Nothing of the kind
 *    happened, and an operator had no way to tell.
 *
 * 2. "Successfully queued outreach sequences for N leads!", produced by a handler that set
 *    `status: "CONTACTED"` in React state and called nothing. A refresh undid it.
 *
 * 3. `scoreBreakdown?.painProbability || 25` and `|| 18`, which fired whenever a component was
 *    absent OR genuinely zero — so a lead nobody had assessed displayed 25 out of 25.
 *
 * 4. `lead.discoveredAt ? ... : "4 days ago"` and
 *    `reasons?.[0] || "High fit clinic profile with evening call volume"` — a date and a
 *    research finding invented for records that had neither.
 *
 * AND ONE POSITIVE CLAIM, WHICH MATTERS MORE THAN THE FOUR
 * -------------------------------------------------------
 * The score and its confidence are shown TOGETHER. `aiScore` is the percentage of the
 * ASSESSABLE points a contact earned, not a mark out of 100, and the two render identically —
 * so a screen that shows one without the other has rebuilt the thing the rubric was rewritten
 * to remove.
 */

const read = (path: string) => readFileSync(path, 'utf8');

/** Comments describe what was removed; an assertion matching one passes for the wrong reason. */
const code = (source: string) =>
  source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const leadsView = code(read('src/pages/LeadsView.tsx'));
const leadDetail = code(read('src/pages/LeadDetailModal.tsx'));
const sourcesView = code(read('src/pages/LeadSourcesView.tsx'));
const scoreCard = code(read('src/components/LeadScoreCard.tsx'));

describe('1. the fabricated discovery modals are gone, not renamed', () => {
  it('none of the three files exists', () => {
    for (const path of [
      'src/components/DiscoverLeadsModal.tsx',
      'src/components/DiscoverInvestorsModal.tsx',
      'src/components/DiscoverPartnersModal.tsx',
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
  });

  it('nothing in the console still calls the batch-generate endpoints', () => {
    // They answer 501 by design. A screen calling one is a button that cannot work.
    for (const [name, source] of [
      ['LeadsView', leadsView],
      ['LeadDetailModal', leadDetail],
      ['LeadSourcesView', sourcesView],
    ] as const) {
      expect(source, name).not.toContain('batch-generate');
    }
  });

  it('the claim about what discovery does is gone with it', () => {
    const all = [leadsView, leadDetail, sourcesView].join('\n');
    expect(all).not.toContain('analyzed for phone reliance');
    expect(all).not.toContain('scored on a 0-100 scale');
  });
});

describe('2. enrolment reaches the server', () => {
  it('the leads list no longer asserts that outreach was queued', () => {
    expect(leadsView).not.toContain('Successfully queued outreach sequences');
  });

  it('bulk enrolment opens the modal that calls the real endpoint', () => {
    expect(leadsView).toContain('EnrolInCampaignModal');
    const modal = code(read('src/components/EnrolInCampaignModal.tsx'));
    expect(modal).toContain('/recipients');
    expect(modal).toContain('apiFetch');
  });

  it('the enrolment result is read from the response, not assumed', () => {
    const modal = code(read('src/components/EnrolInCampaignModal.tsx'));
    // The refusals are the half that matters: a contact who unsubscribed is named, not omitted.
    expect(modal).toContain('refused');
    expect(modal).toContain('res.ok');
  });
});

describe('3. no score component falls back to a default', () => {
  it('the || 25 and || 18 defaults are gone', () => {
    expect(leadDetail).not.toMatch(/painProbability\s*\|\|\s*\d/);
    expect(leadDetail).not.toMatch(/intent\s*\|\|\s*\d/);
    expect(leadDetail).not.toMatch(/icpFit\s*\|\|\s*\d/);
    expect(leadDetail).not.toMatch(/decisionMakerQuality\s*\|\|\s*\d/);
    expect(leadDetail).not.toMatch(/contactability\s*\|\|\s*\d/);
  });

  it('an unscored component renders as "not scored"', () => {
    expect(leadDetail).toContain('not scored');
    expect(scoreCard).toContain('not scored');
  });

  it('no invented date or research finding is left behind', () => {
    expect(leadDetail).not.toContain('4 days ago');
    expect(leadDetail).not.toContain('High fit clinic profile');
  });
});

describe('4. the score never travels without its confidence', () => {
  it('the score card renders both, from the same object', () => {
    expect(scoreCard).toContain('confidence');
    expect(scoreCard).toContain('of the rubric was measurable');
    expect(scoreCard).toContain('of what could be assessed');
  });

  it('the lead detail passes the stored confidence alongside the stored score', () => {
    expect(leadDetail).toContain('storedConfidence');
    expect(leadDetail).toContain('storedScore');
  });

  it('the card says a missing score is missing rather than showing a number', () => {
    expect(scoreCard).toContain('"—"');
    expect(scoreCard).toContain('rather than as a middle value');
  });
});

describe('5. the lead sources screen shows both numbers for every run', () => {
  it('it reports contactable separately from created', () => {
    expect(sourcesView).toContain('contactable today');
    expect(sourcesView).toContain('records created');
  });

  it('every source previews before it commits', () => {
    for (const path of ['/api/leads/import', '/api/leads/discover', '/api/leads/scrape']) {
      expect(sourcesView, path).toContain(path);
    }
    expect(sourcesView).toContain('"PREVIEW"');
    expect(sourcesView).toContain('"COMMIT"');
  });

  it('a commit of an import names the plan that was previewed', () => {
    expect(sourcesView).toContain('expectedPlanHash');
  });

  it('it explains why records cannot be emailed rather than only counting them', () => {
    expect(sourcesView).toContain('Why the rest cannot be emailed yet');
    expect(sourcesView).toContain('refusalCode');
  });
});

describe('6. the lawful basis panel offers a basis, never the permission flag', () => {
  const panel = code(read('src/components/LawfulBasisPanel.tsx'));

  it('there is no input bound to consentGiven', () => {
    // Consent is a record of something that happened in the world; a checkbox in an admin
    // screen is not evidence of it. The flag is derived from the basis, server-side.
    expect(panel).not.toMatch(/setConsentGiven|checked=\{[^}]*consentGiven/);
    expect(panel).not.toMatch(/consentGiven:\s*(true|false)/);
  });

  it('it posts a basis and reads the verdict back', () => {
    expect(panel).toContain('/lawful-basis');
    expect(panel).toContain('mailable');
  });

  it('suppression is shown as outranking any basis', () => {
    expect(panel).toContain('outranks any lawful basis');
  });

  it('the notice cannot be backdated from the console', () => {
    expect(panel).toContain('/api/leads/notice-sent');
    expect(panel).not.toMatch(/article14NoticeSentAt:\s*[^)\n]*(input|value|Date)/);
  });
});
