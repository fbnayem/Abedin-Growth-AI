import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { nextRecoveryVariation } from '../../shared/domain/meetingRecovery';

/**
 * INVARIANTS FOR A TYPE CHECKER THAT CAN SEE THE USER INTERFACE.
 *
 * `@types/react` and `@types/react-dom` were not installed, and `tsconfig.json` has no
 * `noImplicitAny`, so every `import React from "react"` resolved to `any`. `React.FC<Props>` was
 * therefore `any`, every component's props were `any`, and `npx tsc --noEmit` passed over `src/`
 * while checking almost nothing in it. Installing the types surfaced 46 errors in files that had
 * been "clean" for the life of the project; `strictNullChecks` added eighteen more.
 *
 * What those errors were is the point:
 *
 *   - `investor.typicalCheck` beside a field named `typicalCheckSize`, and
 *     `partner.revenueShareModel` beside `revenueModel` — fields rendered as blanks.
 *   - `conv.status === "RESOLVED"` against a union with no RESOLVED member, so CLOSED
 *     conversations were listed as awaiting a reply, and `msg.sender === "AI"` three times against
 *     `"AGENT" | "PROSPECT" | "USER"`.
 *   - `conv.subject.toLowerCase()` on an optional subject, which threw the moment anybody searched
 *     an inbox holding a conversation without one.
 *   - Four child widgets handed props they do not accept, so their callbacks could never fire.
 *
 * The 46 are held by `npm run lint`, which is part of the gate. These assertions hold the
 * configuration that makes them visible, the rule that keeps the browser out of the server, and the
 * pure logic extracted while fixing them.
 */

const EXTENSIONS = ['.ts', '.tsx'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const SRC_FILES = [...walk('src')].filter((f) => EXTENSIONS.some((e) => f.endsWith(e)));

describe('1. the configuration that lets the compiler see the UI', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const tsconfig = JSON.parse(readFileSync('tsconfig.json', 'utf8'));

  it('React ships with types, so a component prop is not silently any', () => {
    expect(pkg.devDependencies['@types/react'], '@types/react is not installed').toBeDefined();
    expect(pkg.devDependencies['@types/react-dom'], '@types/react-dom is not installed').toBeDefined();
  });

  it('strictNullChecks is on', () => {
    expect(tsconfig.compilerOptions.strictNullChecks).toBe(true);
  });

  it('scripts/ is type-checked, by the same lint step the gate runs', () => {
    // The root config EXCLUDES scripts/, so eight files — including db-apply, migrate and
    // db-grants — were never type-checked at all.
    expect(existsSync('tsconfig.scripts.json')).toBe(true);
    const scripts = JSON.parse(readFileSync('tsconfig.scripts.json', 'utf8'));
    expect(scripts.include).toContain('scripts/*.ts');
    expect(scripts.exclude).toEqual([]);
    expect(pkg.scripts.lint).toContain('tsconfig.scripts.json');
  });
});

describe('2. the browser never imports a server module (S40)', () => {
  const SERVER_IMPORT = /from\s+['"](?:\.\.\/)+server\//;

  it('the scan reached the UI', () => {
    // Every assertion below is over SRC_FILES; an empty list would report a clean tree forever.
    expect(SRC_FILES.length).toBeGreaterThan(30);
    expect(SRC_FILES.map((f) => f.replace(/\\/g, '/'))).toContain('src/App.tsx');
  });

  it('no file under src/ imports from server/', () => {
    for (const file of SRC_FILES) {
      expect(readFileSync(file, 'utf8'), `${file} imports a server module`).not.toMatch(SERVER_IMPORT);
    }
  });

  it('that check would catch the four imports S40 found', () => {
    expect('import { AICommandResult } from "../server/agents/growthCommandAgent";').toMatch(SERVER_IMPORT);
    expect('import { AICommandResult } from "../../server/agents/growthCommandAgent";').toMatch(SERVER_IMPORT);
    // A type-only import of the same module would still be flagged: erasure is an optimisation,
    // and the rule is about what the browser is allowed to name.
    expect('import type { X } from "../../server/agents/growthCommandAgent";').toMatch(SERVER_IMPORT);
    // The replacement is not flagged.
    expect('import type { AICommandResult } from "../../shared/domain/growthCommand";').not.toMatch(
      SERVER_IMPORT
    );
  });
});

describe('3. the recovery variation is derived from the stage, never cast from it', () => {
  it('each stage offers the one after it', () => {
    expect(nextRecoveryVariation('NONE')).toBe(1);
    expect(nextRecoveryVariation('DISPATCHED_15MIN')).toBe(2);
    expect(nextRecoveryVariation('DISPATCHED_DAY1_VIDEO')).toBe(3);
    expect(nextRecoveryVariation('DISPATCHED_DAY3_VALUE')).toBe(4);
  });

  it('the last stage has no successor, and does not restart the sequence', () => {
    expect(nextRecoveryVariation('DISPATCHED_DAY5_PHONE_TEST')).toBe(4);
  });

  it('anything unrecognised starts at the first', () => {
    for (const value of [undefined, null, '', 'toString', '__proto__', 'constructor', 2, {}, []]) {
      expect(nextRecoveryVariation(value), JSON.stringify(value) ?? 'undefined').toBe(1);
    }
  });

  it('the answer is always a variation the modal actually offers', () => {
    const stages = [
      'NONE',
      'DISPATCHED_15MIN',
      'DISPATCHED_DAY1_VIDEO',
      'DISPATCHED_DAY3_VALUE',
      'DISPATCHED_DAY5_PHONE_TEST',
      'nonsense',
    ];
    for (const stage of stages) {
      expect([1, 2, 3, 4], stage).toContain(nextRecoveryVariation(stage));
    }
  });
});

describe('4. the interface no longer narrates events that did not happen', () => {
  /**
   * Comments are stripped first, and this is the SIXTH time in this hardening pass that a source
   * assertion had to learn it. Three of these failed on their first run — against the fixes' own
   * explanations. The partner modal's comment quotes "detailing 30% recurring margin", App.tsx's
   * quotes "responding 38% better", and the cadence viewer's JSX comment quotes the 68% claim,
   * because that is how the reason survives. Without stripping, the assertion flags the
   * explanation as the defect, which is precisely what teaches the next person to delete it.
   */
  const strip = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  const source = (path: string) => strip(readFileSync(path, 'utf8'));

  it('the investor timeline does not describe a reply nobody sent', () => {
    const src = source('src/pages/InvestorDetailModal.tsx');
    expect(src).not.toContain('requested 10-slide deck and offered 15-min intro slot');
    expect(src).not.toContain('Dispatched personalized pitch email');
    expect(src).not.toContain('Invests in Seed-stage AI infrastructure');
    // And the claim of an attachment no reply carries.
    expect(src).not.toContain('Attached is our 10-slide Seed Pitch Deck');
  });

  it('the partner timeline does not describe every partner as the same agency', () => {
    const src = source('src/pages/PartnerDetailModal.tsx');
    expect(src).not.toContain('High-volume dental agency');
    expect(src).not.toContain('30% recurring margin');
  });

  it('the dashboard does not open with figures nobody measured', () => {
    const src = source('src/App.tsx');
    expect(src).not.toContain('responding 38% better');
    expect(src).not.toContain('98.4% call resolution');
  });

  it('the cadence viewer does not claim a conversion rate', () => {
    expect(source('src/components/SequenceCadenceViewer.tsx')).not.toContain(
      'Over 68% of booked clinic demos convert'
    );
  });

  it('that check would still catch the claims themselves', () => {
    // Stripping could remove everything, which would make every assertion above true of any file.
    expect(strip('<p>Over 68% of booked clinic demos convert on Step 2</p>')).toContain(
      'Over 68% of booked clinic demos convert'
    );
    expect(strip('<p>{partner.notes || "High-volume dental agency managing 20+"}</p>')).toContain(
      'High-volume dental agency'
    );
    // And a claim quoted inside an explanation is not the claim.
    expect(strip('{/* "Over 68% of booked clinic demos convert" stood here. */}')).not.toContain(
      'Over 68%'
    );
  });
});
