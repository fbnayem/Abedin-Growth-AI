import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

/**
 * S27 — FOUR SOURCES OF ENGAGEMENT DATA, NONE OF THEM MEASURED.
 *
 * There is no open pixel, no click redirect and no bounce or complaint webhook anywhere in this
 * system, and it has never sent an autonomous email. Nothing could have observed an open, a
 * click, a bounce or a spam complaint. Every engagement figure it displayed was manufactured:
 *
 *   - `seedLeadsGenerator.ts` computed it from the LOOP INDEX —
 *     `i % 5 === 0 ? "CLICKED" : i % 3 === 0 ? "OPENED" : "DELIVERED"` — with `spamScore: 0.0`,
 *     `qcScore: 97 + (i % 3)` and `deliverabilityStatus: "VERIFIED_CLEAN"`. Those records are
 *     persisted to `data_storage.json` and reloaded, so they read as recorded history rather
 *     than as fixtures.
 *   - `server.ts` invented `enrolledCount * 0.68` engagement and `* 0.12` conversion at campaign
 *     creation and persisted them onto the campaign.
 *   - `CampaignsView.tsx` built a 30-day series from `Math.sin`, `Math.cos` and `Math.random`
 *     under a comment reading "Add realistic-looking sinusoidal noise", rendered as a
 *     "30-Day Performance Trend" on every active campaign and in the comparison modal.
 *   - The UI asserted `Spam Score: 0.0 • 100% Clean Deliverability` and
 *     `SPF, DKIM, DMARC Verified` as hardcoded strings.
 *
 * The worst case is a founder reading the curve, scaling spend, and reporting the number to an
 * investor while the domain has no DKIM record. The chart is the worst form of it: a figure
 * states a value, a chart asserts a shape over time, and a shape is what a person extrapolates
 * from.
 *
 * These tests read source, because what is being asserted is an ABSENCE — that a fabrication is
 * gone and has not come back somewhere else. The guardrail
 * `scripts/check-no-fabricated-engagement.mjs` enforces the general rule; these pin the four
 * specific sources, by name, so that removing the guardrail does not silently remove the
 * coverage with it.
 */

const seed = readFileSync('server/seedLeadsGenerator.ts', 'utf8');
const server = readFileSync('server.ts', 'utf8');
const campaigns = readFileSync('src/pages/CampaignsView.tsx', 'utf8');
const compare = readFileSync('src/pages/CampaignCompareModal.tsx', 'utf8');
const models = readFileSync('shared/domain/models.ts', 'utf8');

const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*(?:\/\/|\*)[^\n]*$/gm, '');

// ===========================================================================
describe('1. the seed generator invents no engagement', () => {
  it('no delivery or engagement state is derived from the loop index', () => {
    expect(code(seed)).not.toMatch(/i\s*%\s*\d+[\s\S]{0,80}["'](OPENED|CLICKED|DELIVERED)["']/);
  });

  it('no spam score or deliverability verdict is asserted', () => {
    expect(code(seed)).not.toMatch(/spamScore:\s*0/);
    expect(code(seed)).not.toMatch(/VERIFIED_CLEAN/);
  });

  it('no quality score is invented from the loop index', () => {
    expect(code(seed)).not.toMatch(/qcScore:\s*9\d\s*\+/);
  });

  /**
   * A seeded touch was never sent, so it was never delivered and nobody opened it. SIMULATED is
   * what actually happened, and it is deliberately not a value a real send can produce.
   */
  it('a seeded send is recorded as SIMULATED', () => {
    expect(code(seed)).toMatch(/outboxStatus:\s*OutboxLogItem\["status"\]\s*=\s*"SIMULATED"/);
  });

  /**
   * The absence is the point. A zero renders as a measured zero — "0 opens" is a claim that
   * somebody looked. An absent field renders as nothing, which is accurate.
   */
  it('engagement fields are absent rather than zeroed', () => {
    const body = code(seed);
    expect(body).not.toMatch(/openCount:\s*0\b/);
    expect(body).not.toMatch(/lastOpenedAt:\s*new Date/);
  });
});

// ===========================================================================
describe('2. the campaign projection is gone', () => {
  it('no engagement or conversion rate is invented from the enrolment count', () => {
    expect(code(server)).not.toMatch(/projectedReach\s*\*\s*0\.\d+/);
    expect(code(server)).not.toMatch(/\*\s*0\.68|\*\s*0\.12/);
  });

  /**
   * Reach IS a fact — it is the enrolment count. Engagement and conversion are reported as
   * null with a reason, rather than dropped silently: a missing key reads as an oversight,
   * and a null with a reason reads as a decision.
   */
  it('reach is still reported, and the other two say why they are not', () => {
    expect(code(server)).toMatch(/projectedMetrics:\s*\{\s*reach:\s*projectedReach/);
    expect(code(server)).toMatch(/engagement:\s*null/);
    expect(code(server)).toMatch(/conversion:\s*null/);
    expect(code(server)).toMatch(/not measured/);
  });
});

// ===========================================================================
describe('3. the sine-wave chart is gone from every render site', () => {
  it('the generator no longer exists', () => {
    expect(code(campaigns)).not.toMatch(/export const generateMockChartData/);
  });

  it('no engagement series is generated from randomness or a wave', () => {
    expect(code(campaigns)).not.toMatch(/Math\.(random|sin|cos)\s*\(/);
    expect(code(compare)).not.toMatch(/Math\.(random|sin|cos)\s*\(/);
  });

  /** Both card render sites and the comparison modal. Removing one and leaving two is the risk. */
  it('every former chart site renders the not-tracked state instead', () => {
    expect(code(campaigns).match(/<NoEngagementData\b/g)?.length).toBe(2);
    expect(code(compare).match(/<NoEngagementData\b/g)?.length).toBe(1);
    expect(code(compare)).not.toMatch(/generateMockChartData/);
  });

  /**
   * And it says why there is nothing, rather than looking like a chart that failed to load.
   * "No data yet" invites waiting; the accurate statement is that nothing is collected.
   */
  it('the empty state explains that nothing is collected, not that nothing has happened yet', () => {
    expect(campaigns).toMatch(/no open, click or bounce ingestion/i);
  });
});

// ===========================================================================
describe('4. a simulated send cannot be recorded as a real one', () => {
  /**
   * S27 asks for this directly: persist simulated sends with `status: 'SIMULATED'`, never
   * `'SENT'`. Without the value in the union the only available answers were SENT and
   * DELIVERED, so a send that never left the process was recorded as one that had.
   */
  it('SIMULATED is a first-class status', () => {
    expect(models).toMatch(/status:\s*'SIMULATED'\s*\|/);
  });

  /**
   * DELIVERED is a claim about what a recipient's mail server did. Nothing here has ever heard
   * from one — there is no bounce or complaint webhook — so "accepted by the provider" and
   * "delivered" are not distinguishable in this system, and the type says so.
   */
  it('the type records why DELIVERED is not a claim this system can make', () => {
    expect(models).toMatch(/accepted by Gmail.*delivered|delivered.*not distinguishable/is);
  });

  /** A score nothing computes must not be required, or every writer has to invent one. */
  it('the quality score is optional', () => {
    expect(models).toMatch(/qcScore\?:\s*number;/);
  });
});
