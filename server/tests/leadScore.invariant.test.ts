import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
import { memory } from './helpers/memoryDocumentStore';

import {
  COMPONENT_KEYS,
  COMPONENT_MAX,
  RUBRIC_VERSION,
  scoreLead,
  type IcpDefinition,
  type ScorableContact,
} from '../domain/leadScore';
import { previewScore, scoreContacts } from '../services/leadScore.service';
import type { Attribution } from '../domain/operatorAction';

/**
 * INVARIANTS FOR LEAD QUALIFICATION (addendum §8, §14, §26, §50).
 *
 * THE ONE THAT MATTERS
 * --------------------
 * A COMPONENT WITH NO INPUT IS NOT SCORED. Not zero, not half, not a default. The generator
 * this replaces produced `icpFit: Math.min(30, 24 + (i % 6))` from a loop index, and the
 * obvious fix — `industryMatches ? 30 : 15` — reintroduces the same defect in a form that looks
 * principled: a lead with no industry recorded would score 15, which is indistinguishable
 * downstream from a lead that was assessed and found mediocre.
 *
 * So these tests are mostly about ABSENCE. For each component they establish the input, remove
 * it, and require `null` rather than a number. The two exceptions — where zero is a genuine
 * measurement — are pinned individually with the reasoning stated, because a rule with
 * exceptions decays into no rule unless the exceptions are named.
 *
 * §50: the question is not whether the rubric is correct — reasonable people weight seniority
 * differently. It is whether a missing input can ever become a number.
 */

const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };
const ORG = 'org-a';
const NOW = new Date('2026-09-15T12:00:00.000Z');

const ICP: IcpDefinition = {
  targetIndustries: ['Dental Practices', 'Private Healthcare'],
  targetCountries: ['GB', 'US'],
  targetPersonas: [
    {
      title: 'Practice Owner',
      department: 'Operations',
      painPoint: 'evening callers reach voicemail and the appointment is lost',
    },
  ],
};

/** A contact with every input present, so a test can remove exactly one. */
const FULL: ScorableContact = {
  email: 'jane@harleydental.example',
  title: 'Managing Director',
  industry: 'Dental Practices',
  country: 'GB',
  companyName: 'Harley Dental',
  timeZone: 'Europe/London',
  phone: '+44 20 7000 0000',
  notes: 'Website promises same-day appointments but evening callers reach voicemail.',
  lawfulBasis: 'LEGITIMATE_INTEREST',
  addressType: 'PERSONAL',
  liaId: 'lia_2026_q3_uk_b2b',
  article14NoticeSentAt: '2026-09-10T09:00:00.000Z',
  contactedAt: '2026-09-11T09:00:00.000Z',
  openCount: 4,
};

const componentOf = (contact: ScorableContact, key: string, icp: IcpDefinition = ICP) =>
  scoreLead(contact, icp).components.find((c) => c.key === key)!;

beforeEach(() => memory.reset());

describe('lead score: a missing input is never a number', () => {
  it('ICP fit is not scored when the company brain declares no targets', () => {
    const c = componentOf(FULL, 'icpFit', {});
    expect(c.score).toBeNull();
    expect(c.why).toContain('Not scored');
  });

  it('ICP fit is not scored when the contact has neither industry nor country', () => {
    const c = componentOf({ ...FULL, industry: undefined, country: undefined }, 'icpFit');
    expect(c.score).toBeNull();
  });

  it('decision-maker quality is not scored without a job title', () => {
    for (const title of [undefined, null, '', '   ']) {
      expect(componentOf({ ...FULL, title }, 'decisionMakerQuality').score).toBeNull();
    }
  });

  it('an unrecognised job title is unknown seniority, not middling seniority', () => {
    // The tempting defect: a title the rubric does not recognise scoring somewhere in the
    // middle. "Chief Vibes Officer" is not evidence of anything.
    const c = componentOf({ ...FULL, title: 'Zorb Wrangler' }, 'decisionMakerQuality');
    expect(c.score).toBeNull();
    expect(c.why).toContain('not middling seniority');
  });

  it('pain probability is not scored when nothing on the record is evidence of pain', () => {
    expect(componentOf({ ...FULL, notes: undefined }, 'painProbability').score).toBeNull();
  });

  it('pain probability is not scored when the brain declares no pain points to match', () => {
    const c = componentOf(FULL, 'painProbability', { ...ICP, targetPersonas: [{ title: 'Owner' }] });
    expect(c.score).toBeNull();
  });

  it('intent is not scored for a contact that has never been sent anything', () => {
    const fresh: ScorableContact = { ...FULL, contactedAt: undefined, openCount: 0, clickedAt: undefined, repliedAt: undefined, emailStatus: undefined };
    const c = componentOf(fresh, 'intent');
    expect(c.score).toBeNull();
    expect(c.why).toContain('never been sent anything');
  });

  it('an empty record is assessed on contactability alone, and the confidence says so', () => {
    const result = scoreLead({}, {});
    // Contactability is always assessable — suppression and a lawful basis are facts about the
    // record rather than about the world — so 10 of the 100 points can always be scored. That
    // is why a score is always a number, and why the number alone is not the finding.
    expect(result.assessable).toBe(COMPONENT_MAX.contactability);
    expect(result.confidence).toBe(10);
    expect([...result.notScored].sort()).toEqual(
      ['decisionMakerQuality', 'icpFit', 'intent', 'painProbability'].sort()
    );
  });

  it('no component ever returns a value outside zero and its maximum', () => {
    const contacts: ScorableContact[] = [
      {},
      FULL,
      { ...FULL, openCount: 10_000 },
      { ...FULL, openCount: -5 },
      { ...FULL, title: 'Founder and CEO and Owner and Chief' },
      { ...FULL, suppressed: true },
      { ...FULL, industry: 'Nothing Like The Targets' },
    ];
    for (const contact of contacts) {
      for (const c of scoreLead(contact, ICP).components) {
        if (c.score === null) continue;
        expect(c.score).toBeGreaterThanOrEqual(0);
        expect(c.score).toBeLessThanOrEqual(c.max);
        expect(Number.isInteger(c.score)).toBe(true);
      }
    }
  });
});

describe('lead score: the two places where zero IS a measurement', () => {
  it('a contacted lead with no engagement scores zero for intent, not unscored', () => {
    const c = componentOf({ ...FULL, openCount: 0, clickedAt: undefined, repliedAt: undefined, emailStatus: undefined }, 'intent');
    expect(c.score).toBe(0);
    expect(c.why).toContain('measurement, not a gap');
  });

  it('a contact whose industry does not match scores low, not unscored', () => {
    const c = componentOf({ ...FULL, industry: 'Municipal Waste Haulage' }, 'icpFit');
    expect(c.score).not.toBeNull();
    expect(c.score! < COMPONENT_MAX.icpFit).toBe(true);
    // The country still matches, so it is not zero either. Both halves are reported.
    expect(c.why).toContain('not among the');
  });

  it('a suppressed contact scores zero for contactability', () => {
    for (const flag of ['suppressed', 'unsubscribed', 'hardBounced', 'complained']) {
      const c = componentOf({ ...FULL, [flag]: true }, 'contactability');
      expect(c.score).toBe(0);
    }
  });
});

describe('lead score: the score and the confidence are different numbers', () => {
  it('a fully assessable contact reports confidence 100', () => {
    const result = scoreLead(FULL, ICP);
    expect(result.confidence).toBe(100);
    expect(result.notScored).toEqual([]);
    expect(result.score).not.toBeNull();
  });

  it('a bare contact can score high on very little, and says so', () => {
    // This is the whole point. A contact with only an address and a basis can reach a high
    // percentage of what could be assessed while almost nothing was assessed — and collapsing
    // the two into one number is exactly the lie the old generator told.
    const thin: ScorableContact = {
      email: 'info@acme.example',
      country: 'GB',
      lawfulBasis: 'LEGITIMATE_INTEREST',
      addressType: 'ROLE',
      liaId: 'lia_1',
      article14NoticeSentAt: '2026-09-10T09:00:00.000Z',
      timeZone: 'Europe/London',
      phone: '+44 20 7000 0000',
    };
    const result = scoreLead(thin, {});
    expect(result.score).toBe(100);
    expect(result.confidence).toBe(COMPONENT_MAX.contactability);
    expect(result.confidence).toBeLessThan(15);
    // The same number, on a record that was actually researched, means something else entirely.
    expect(scoreLead(FULL, ICP).confidence).toBe(100);
  });

  it('the confidence is the share of the rubric that could be assessed', () => {
    const result = scoreLead(FULL, ICP);
    const assessableMax = result.components
      .filter((c) => c.score !== null)
      .reduce((sum, c) => sum + c.max, 0);
    expect(result.assessable).toBe(assessableMax);
    expect(result.confidence).toBe(Math.round((assessableMax / 100) * 100));
  });

  it('the score is a percentage of what was assessable, not of 100', () => {
    const contact: ScorableContact = { email: 'info@acme.example', suppressed: true };
    const result = scoreLead(contact, {});
    // Contactability scored 0 of 10; nothing else was assessable. If the score were a
    // percentage of 100 rather than of what was assessed, every thin record would look bad in
    // the same way as a thoroughly researched bad one.
    expect(result.earned).toBe(0);
    expect(result.assessable).toBe(10);
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(10);
  });
});

describe('lead score: every component explains itself', () => {
  it('each component names the rule or the missing input', () => {
    for (const contact of [FULL, {}, { ...FULL, title: undefined }]) {
      for (const c of scoreLead(contact, ICP).components) {
        expect(c.why.length).toBeGreaterThan(20);
        expect(COMPONENT_KEYS).toContain(c.key);
      }
    }
  });

  it('an unscored component is reported as a risk, because not knowing is a risk', () => {
    const result = scoreLead({ ...FULL, title: undefined }, ICP);
    expect(result.risks.some((r) => r.startsWith('decisionMakerQuality'))).toBe(true);
  });

  it('the weights are the ones ScoreBreakdown has always declared, and sum to 100', () => {
    expect(Object.values(COMPONENT_MAX).reduce((a, b) => a + b, 0)).toBe(100);
    expect(COMPONENT_MAX).toEqual({
      icpFit: 30,
      painProbability: 25,
      intent: 20,
      decisionMakerQuality: 15,
      contactability: 10,
    });
  });

  it('the same record and rubric always produce the same score', () => {
    const a = scoreLead(FULL, ICP);
    const b = scoreLead(FULL, ICP);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('lead score: what gets stored', () => {
  const path = (id: string) => `organizations/${ORG}/contacts/${id}`;

  function seed(id: string, contact: Record<string, unknown>) {
    memory.docs[path(id)] = { id, version: 1, ...contact };
  }

  it('an unattributed caller cannot score, and nothing is written', async () => {
    seed('ct_a', FULL as Record<string, unknown>);
    const before = JSON.stringify(memory.docs);
    const outcome = await scoreContacts(ORG, ['ct_a'], NOBODY, { now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(JSON.stringify(memory.docs)).toBe(before);
  });

  /** The company brain, so ICP fit and pain probability have something to measure against. */
  function seedBrain() {
    memory.docs[`organizations/${ORG}/company_brain/main`] = {
      targetIndustries: [...(ICP.targetIndustries ?? [])],
      targetCountries: [...(ICP.targetCountries ?? [])],
      targetPersonas: (ICP.targetPersonas ?? []).map((p) => ({ ...p })),
    };
  }

  it('a stored score carries its rubric version, its time and its operator', async () => {
    seedBrain();
    seed('ct_a', FULL as Record<string, unknown>);
    const outcome = await scoreContacts(ORG, ['ct_a'], NAMED, { now: NOW });
    expect(outcome.ok).toBe(true);
    const stored = memory.docs[path('ct_a')] as Record<string, unknown>;
    expect(stored.scoreRubricVersion).toBe(RUBRIC_VERSION);
    expect(stored.scoredAt).toBe(NOW.toISOString());
    expect(stored.scoredBy).toBe('ops@abedin.example');
    expect(stored.scoreConfidence).toBe(100);
  });

  it('a score is never stored without the confidence that makes it readable', async () => {
    // The field a list view sorts by. `aiScore: 87` beside `scoreConfidence: 10` is a
    // different claim from `aiScore: 87` beside `scoreConfidence: 100`, and storing the first
    // without the second is how the old generator's number came to look like research.
    seedBrain();
    seed('ct_a', FULL as Record<string, unknown>);
    seed('ct_b', { id: 'ct_b', version: 1 });
    await scoreContacts(ORG, ['ct_a', 'ct_b'], NAMED, { now: NOW });
    for (const id of ['ct_a', 'ct_b']) {
      const stored = memory.docs[path(id)] as Record<string, unknown>;
      expect(typeof stored.aiScore).toBe('number');
      expect(typeof stored.scoreConfidence).toBe('number');
    }
    // The thin record is assessed on a tenth of the rubric, and says so.
    expect((memory.docs[path('ct_b')] as Record<string, unknown>).scoreConfidence).toBe(
      COMPONENT_MAX.contactability
    );
    expect((memory.docs[path('ct_a')] as Record<string, unknown>).scoreConfidence).toBe(100);
  });

  it('the breakdown names every component that could not be assessed', async () => {
    seed('ct_b', { id: 'ct_b', version: 1 });
    await scoreContacts(ORG, ['ct_b'], NAMED, { now: NOW });
    const stored = memory.docs[path('ct_b')] as Record<string, unknown>;
    const breakdown = stored.scoreBreakdown as { notScored: string[]; components: { score: number | null }[] };
    expect([...breakdown.notScored].sort()).toEqual(
      ['decisionMakerQuality', 'icpFit', 'intent', 'painProbability'].sort()
    );
    expect(breakdown.components.filter((c) => c.score === null)).toHaveLength(4);
  });

  it('scoring never touches a suppression flag or a lawful basis', async () => {
    seed('ct_c', { ...FULL, unsubscribed: true, suppressed: true, consentGiven: false } as Record<string, unknown>);
    await scoreContacts(ORG, ['ct_c'], NAMED, { now: NOW });
    const stored = memory.docs[path('ct_c')] as Record<string, unknown>;
    expect(stored.unsubscribed).toBe(true);
    expect(stored.suppressed).toBe(true);
    expect(stored.lawfulBasis).toBe('LEGITIMATE_INTEREST');
    expect(stored.consentGiven).toBe(false);
  });

  it('the patch names no field outside the score, which a source scan confirms', () => {
    // Behavioural tests prove the fields they check. This proves the ones nobody thought of:
    // the patch is a literal, and a field absent from it cannot be written by this path.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    const source = stripComments(readFileSync('server/services/leadScore.service.ts', 'utf8'));
    const patch = source.slice(source.indexOf('export function scorePatch'), source.indexOf('previewScore'));
    for (const forbidden of ['suppressed', 'unsubscribed', 'consentGiven', 'lawfulBasis', 'hardBounced', 'complained', 'email']) {
      expect(patch).not.toContain(forbidden);
    }
    expect(patch).toContain('aiScore');
  });

  it('a batch beyond the limit reports what it did not reach', async () => {
    for (let i = 0; i < 5; i++) seed(`ct_${i}`, FULL as Record<string, unknown>);
    const outcome = await scoreContacts(ORG, [], NAMED, { limit: 2, now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scored).toBe(2);
    expect(outcome.unreachable).toBe(3);
  });

  it('a preview computes without storing', async () => {
    seed('ct_a', FULL as Record<string, unknown>);
    const before = JSON.stringify(memory.docs);
    const outcome = await previewScore(ORG, 'ct_a');
    expect(outcome.ok).toBe(true);
    expect(JSON.stringify(memory.docs)).toBe(before);
  });

  it('a preview of a contact that does not exist is a refusal, not a zero score', async () => {
    const outcome = await previewScore(ORG, 'ct_missing');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NOT_FOUND');
  });

  it('the profile is read from the company brain, so an edit changes the score', async () => {
    seed('ct_a', { email: 'jane@acme.example', industry: 'Dental Practices', country: 'GB' });
    const without = await previewScore(ORG, 'ct_a');
    if (!without.ok) throw new Error('refused');
    expect(without.result.components.find((c) => c.key === 'icpFit')!.score).toBeNull();

    memory.docs[`organizations/${ORG}/company_brain/main`] = {
      targetIndustries: ['Dental Practices'],
      targetCountries: ['GB'],
    };
    const withBrain = await previewScore(ORG, 'ct_a');
    if (!withBrain.ok) throw new Error('refused');
    expect(withBrain.result.components.find((c) => c.key === 'icpFit')!.score).toBe(30);
  });
});

describe('lead score: the fabricating generator is not coming back', () => {
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const source = stripComments(readFileSync('server/domain/leadScore.ts', 'utf8'));

  it('the rubric contains no arithmetic on an index or a random number', () => {
    expect(source).not.toContain('Math.random');
    expect(source).not.toMatch(/%\s*\d+\s*\)/);
  });

  it('every component function can return null', () => {
    // If one of them lost its "not scored" branch, the score would silently start defaulting.
    const bodies = source.split('function score').slice(1);
    const componentBodies = bodies.filter((b) => b.startsWith('IcpFit') || b.startsWith('PainProbability') || b.startsWith('Intent') || b.startsWith('DecisionMaker'));
    expect(componentBodies).toHaveLength(4);
    for (const body of componentBodies) {
      expect(body).toContain('score: null');
    }
  });
});
