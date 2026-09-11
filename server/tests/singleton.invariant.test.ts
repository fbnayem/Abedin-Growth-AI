import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mergeSingletonBody } from '../lib/singleton';

/**
 * INVARIANTS FOR THE TWO SINGLETON DOCUMENTS.
 *
 * `apiContracts.ts` says of the company brain and the settings: "Every field is optional: these are
 * partial updates to a singleton, not full replacements." The handler passed `() => body` to
 * `mutateWithVersion`, which writes the document WHOLE — so a partial body replaced the whole
 * document. `POST /api/company-brain` with `{ tagline }` would have erased every persona, objection
 * answer and narrative in the organisation's brain, at version + 1.
 *
 * Nothing had ever sent one, because no UI wrote to that endpoint: the brain editor's Save button
 * called `setState` and stopped. The contract said partial, the handler did whole, and the gap was
 * invisible because the feature was never connected.
 */

const BRAIN = {
  companyName: 'Acme',
  tagline: 'old tagline',
  targetIndustries: ['Dental'],
  investorNarrative: { vision: 'v', marketOpportunity: 'm', moat: 'm', tractionHighlights: 't' },
  version: 7,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('1. a partial update keeps what it did not mention', () => {
  it('THE INVARIANT — one field changes and the rest survive', () => {
    const merged = mergeSingletonBody(BRAIN, { tagline: 'new tagline' });

    expect(merged.tagline).toBe('new tagline');
    expect(merged.companyName).toBe('Acme');
    expect(merged.targetIndustries).toEqual(['Dental']);
    expect(merged.investorNarrative).toEqual(BRAIN.investorNarrative);
  });

  it('an empty body changes nothing', () => {
    const merged = mergeSingletonBody(BRAIN, {});
    expect(merged.companyName).toBe('Acme');
    expect(merged.tagline).toBe('old tagline');
  });

  it('and the body wins where the two disagree', () => {
    // The other half: a merge that preferred the stored value would make every edit a no-op.
    expect(mergeSingletonBody(BRAIN, { companyName: 'Beta' }).companyName).toBe('Beta');
  });

  it('a document that does not exist yet is created from the body alone', () => {
    expect(mergeSingletonBody(null, { companyName: 'Acme' })).toEqual({ companyName: 'Acme' });
  });
});

describe('2. the fields the writer stamps are never carried forward', () => {
  it('version and updatedAt are dropped from the merged document', () => {
    // `mutateWithVersion` stamps both AFTER `produceNext` returns. Carrying them would write a
    // value about to be overwritten — harmless until somebody changes the stamping order.
    const merged = mergeSingletonBody(BRAIN, { tagline: 'x' });
    expect(merged).not.toHaveProperty('version');
    expect(merged).not.toHaveProperty('updatedAt');
  });

  it('including when the body itself carries them', () => {
    const merged = mergeSingletonBody(BRAIN, { tagline: 'x', version: 99, updatedAt: 'nonsense' });
    expect(merged).not.toHaveProperty('version');
    expect(merged).not.toHaveProperty('updatedAt');
  });
});

describe('3. the handler composes the merge rather than replacing the document', () => {
  const source = readFileSync('server.ts', 'utf8');
  const handler = source.slice(source.indexOf('async function writeSingleton'));
  const code = handler
    .slice(0, handler.indexOf('\n  }'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  it('writeSingleton passes a merging producer, not the body', () => {
    expect(code).toContain('mergeSingletonBody(current, body)');
    expect(code).not.toMatch(/mutateWithVersion\([^)]*\(\)\s*=>\s*body\s*\)/);
  });

  it('that check would catch the whole-document write coming back', () => {
    const regressed = 'const outcome = await mutateWithVersion(ref, expected.value, () => body);';
    expect(regressed).toMatch(/mutateWithVersion\([^)]*\(\)\s*=>\s*body\s*\)/);
  });
});

describe('4. the interface writes what it says it writes', () => {
  /**
   * These are source assertions because `vitest.config.ts` is `environment: 'node'` and includes
   * only `server/tests/**`: no component here can be rendered. What they pin is the wiring the
   * behaviour depends on — a save that posts, a version that travels with it, an editor that stays
   * open when the save failed, and a banner that does not announce a brain nobody built.
   */
  const knowledge = readFileSync('src/pages/KnowledgeView.tsx', 'utf8');
  const app = readFileSync('src/App.tsx', 'utf8');
  const onboarding = readFileSync('src/pages/OnboardingModal.tsx', 'utf8');

  /**
   * Scoped to the handler, because two mutants survived a version of this that was not.
   *
   * App.tsx also GETs `/api/company-brain` during its initial load, and it handles a 409 for
   * campaigns several hundred lines earlier — so `expect(app).toContain(...)` passed with the save
   * pointed at a dead URL and with the conflict branch deleted. That is a statement about the
   * assertion, not about the code.
   */
  const saveHandlerAt = app.indexOf('onUpdateBrain={async');
  const saveHandler = saveHandlerAt === -1 ? '' : app.slice(saveHandlerAt, saveHandlerAt + 1600);

  it('the save handler is where the assertions below think it is', () => {
    expect(saveHandlerAt).toBeGreaterThan(-1);
  });

  it('Save POSTs to the brain endpoint, with the version it read', () => {
    // The POST's exact call shape, not just the URL: the handler ALSO refetches the brain on a
    // 409, so a needle ending at the closing quote matched that instead and the mutant that
    // pointed the save at a dead endpoint survived.
    expect(saveHandler).toContain('apiFetch("/api/company-brain", {');
    expect(saveHandler).toContain('method: "POST"');
    expect(saveHandler).toContain('"If-Match": String(companyBrain.version ?? 0)');
  });

  it('a concurrent edit is shown rather than overwritten', () => {
    expect(saveHandler).toContain('res.status === 409');
  });

  it('the editor closes only when the save succeeded', () => {
    // Closing it regardless is what makes a person believe a failed edit was stored.
    const handler = knowledge.slice(knowledge.indexOf('const handleSaveBrain'));
    const body = handler.slice(0, handler.indexOf('};'));
    expect(body).toContain('if (outcome.ok)');
    expect(body.indexOf('outcome.ok')).toBeLessThan(body.indexOf('setEditingBrain(false)'));
    expect(body).toContain('setSaveError(outcome.message)');
  });

  it('and the failure is shown to the operator, not only to the console', () => {
    expect(knowledge).toContain('The brain was not saved.');
  });

  it('generation states the version too, so the route can answer', () => {
    // Without it the route answers 428 VERSION_REQUIRED every time, which is what it did.
    expect(onboarding).toContain('"If-Match": String(initialBrain?.version ?? 0)');
  });

  it("a previous brain is not shown as this run's result", () => {
    const handler = onboarding.slice(onboarding.indexOf('const handleRunAnalysis'));
    expect(handler.slice(0, handler.indexOf('try {'))).toContain('setGeneratedBrain(null)');
  });

  it('and success is announced only when there is something to announce', () => {
    expect(onboarding).toContain('{generateError ? (');
    expect(onboarding).toContain('No company brain was generated');
    const complete = onboarding.slice(onboarding.indexOf('onClick={handleComplete}'));
    expect(complete.slice(0, 200)).toContain('disabled={!generatedBrain}');
  });
});
