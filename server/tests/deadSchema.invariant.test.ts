import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * INVARIANTS FOR CODE AND SCHEMA THAT ARE DEAD ON PURPOSE (addendum S1).
 *
 * S1 is about dead modules and competing owners. Two of them were found while completing S26,
 * and neither was harmless:
 *
 *   - `services/pipeline.service.ts` was a second inbound pipeline with `contactId =
 *     "mock_contact_id"`, `conversationId = "mock_conversation_id"` and
 *     `previousContext = "Prior emails..."`. Zero callers.
 *   - `services/suppression.service.ts` was its suppression check, and it read
 *     `global.suppressionList` — an in-memory array that no real contact is ever in. It would
 *     answer "not suppressed" for every recipient in the system, and its `processUnsubscribe`
 *     ended in a `try {}` containing a comment saying "This is a stub for the logic".
 *
 * The second is the one that mattered. S26 has just landed a real unsubscribe writing the field
 * the gateway enforces on; leaving a second suppression path that always answers "clear" is how
 * two owners of one decision come to disagree, and the dead one reads as the live one to anyone
 * who greps for "suppression".
 *
 * This file keeps them dead, and keeps the retired `outbox_messages` table from acquiring a
 * writer.
 */

const ROOTS = ['server', 'src', 'shared'];
const EXTENSIONS = ['.ts', '.tsx'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTENSIONS.some((e) => entry.endsWith(e))) yield full;
  }
}

/**
 * Comments are stripped before scanning, and finding that out cost a failing run.
 *
 * `controllers/killSwitch.controller.ts` carried
 * `// await db.update(outboxMessages).set({ status: 'CANCELLED' })` — a commented-out write,
 * flagged as a live one. That is the fix explaining itself being read as the defect, which is
 * what teaches people to delete the explanation.
 *
 * (That file is gone now for its own reasons, but the stripping stays: the reasons for these
 * rules are recorded in comments, and a scan that cannot tell a reason from a call cannot be
 * used to record reasons.)
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

const FILES = ROOTS.filter((r) => existsSync(r)).flatMap((r) => [...walk(r)]);
const SOURCES = FILES.filter((f) => !f.includes('tests')).map((f) => ({
  path: f,
  code: withoutComments(readFileSync(f, 'utf8')),
}));

describe('1. the scan actually looked at the tree', () => {
  it('found a plausible number of source files', () => {
    // A suite that scans nothing passes forever. Every assertion below is over `SOURCES`, so
    // this is what stops an empty list reading as a clean tree.
    //
    // NOTE, recorded rather than hidden: relaxing this bound is a mutant that SURVIVES the
    // gate, and it is unexpressible against this tree. A count floor is insurance, and no
    // assertion can detect insurance being removed while the insured event has not happened —
    // it would take a tree with fewer than a hundred files to tell the two versions apart.
    // The assertion below is the expressible half, and it covers the defect the floor insures
    // against.
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  /**
   * WHAT THE FLOOR IS ACTUALLY GUARDING, STATED AS SOMETHING THAT CAN FAIL.
   *
   * The risk is that `walk()` silently returns nothing — a renamed directory, a changed
   * extension list, a `SKIP` entry that swallows a root — after which every assertion in this
   * file passes over an empty list and reports a clean tree forever.
   *
   * Naming files that must be there turns that from a count into a fact. A broken walk fails
   * here with the name of what it lost, rather than passing quietly.
   */
  it('found the specific files these rules are about', () => {
    const paths = new Set(SOURCES.map(({ path }) => path.replace(/\\/g, '/')));
    for (const required of [
      'server/gateway/actionGateway.ts',
      'server/services/outbox.service.ts',
      'server/services/circuitBreaker.service.ts',
      'server/agents/salesDecisionEngine.ts',
      'server/db/schema.ts',
      'src/pages/OutboxView.tsx',
      'shared/domain/autonomyDisplay.ts',
    ]) {
      expect(paths.has(required), `the scan did not reach ${required}`).toBe(true);
    }
  });
});

describe('2. the shadow pipeline and its fake suppression stay deleted', () => {
  for (const gone of [
    'server/services/pipeline.service.ts',
    'server/services/suppression.service.ts',
    // The third one, found by this suite's own failure. `circuitBreaker.service.ts` already
    // described it as unreachable in its header: a kill switch that flipped a process-local
    // boolean, invisible to a second replica, gone on restart, answering `success: true`. What
    // an operator finds when they go looking during an incident.
    'server/controllers/killSwitch.controller.ts',
  ]) {
    it(`${gone} does not exist`, () => {
      expect(existsSync(gone), `${gone} is back`).toBe(false);
    });
  }

  it('nothing imports any of them', () => {
    for (const { path, code } of SOURCES) {
      expect(code, `${path} imports the deleted pipeline`).not.toMatch(
        /from\s+['"][^'"]*\/pipeline\.service['"]/
      );
      expect(code, `${path} imports the deleted suppression service`).not.toMatch(
        /from\s+['"][^'"]*\/suppression\.service['"]/
      );
      expect(code, `${path} imports the deleted kill-switch controller`).not.toMatch(
        /from\s+['"][^'"]*killSwitch\.controller['"]/
      );
    }
  });

  /**
   * EXACTLY ONE MODULE MAY WRITE THE IN-PROCESS SEND FLAG, AND IT IS THE ONE THAT DERIVES IT.
   *
   * The first version of this asserted that NOBODY assigns
   * `circuitBreaker.globalAutonomousSendEnabled`, and it failed on the live service — which
   * assigns it deliberately, as a cache of the durable decision, with the reason written beside
   * it: "Keep the legacy in-process flag consistent with the durable decision, so code paths
   * that still read it synchronously cannot disagree with this service."
   *
   * That is the correct design, and an assertion that forbade it was reading the fix as the
   * defect. What made the DELETED controller useless was not that it touched the flag; it was
   * that the flag was the ONLY record — invisible to a second replica and gone on restart.
   *
   * So the invariant is the writer count, not the write.
   */
  it('the in-process send flag has exactly one writer, and it derives it from durable state', () => {
    const writers = SOURCES.filter(({ code }) =>
      /circuitBreaker\s*\.\s*globalAutonomousSendEnabled\s*=[^=]/.test(code)
    ).map(({ path }) => path.replace(/\\/g, '/'));

    expect(writers, `unexpected writers of the send flag: ${writers.join(', ')}`).toEqual([
      'server/services/circuitBreaker.service.ts',
    ]);
  });

  it('that check would catch a second writer', () => {
    // A pattern matching nothing would make the assertion above pass with an empty array,
    // which is the opposite of what it claims.
    expect(
      /circuitBreaker\s*\.\s*globalAutonomousSendEnabled\s*=[^=]/.test(
        'circuitBreaker.globalAutonomousSendEnabled = false;'
      )
    ).toBe(true);
    // ...and a READ is not a write.
    expect(
      /circuitBreaker\s*\.\s*globalAutonomousSendEnabled\s*=[^=]/.test(
        'if (circuitBreaker.globalAutonomousSendEnabled === true) return;'
      )
    ).toBe(false);
  });

  /**
   * The in-memory suppression list is the specific defect, not just the file.
   *
   * `global.suppressionList` would answer "not suppressed" for every contact in a real
   * deployment, because nothing ever put a real address in it. A check that cannot fail is
   * worse than no check: the independent auditor recorded its answer as `suppression: 'CLEAN'`
   * against drafts.
   *
   * The authority is the contact record, which `actionGateway` reads and the S26 unsubscribe
   * endpoint writes.
   */
  it('no global in-memory suppression list comes back', () => {
    for (const { path, code } of SOURCES) {
      expect(code, `${path} reintroduces an in-memory suppression list`).not.toMatch(
        /global\s*\.\s*suppressionList|var\s+suppressionList/
      );
    }
  });

  it('these checks would catch the code they are about', () => {
    // Without this, patterns matching nothing satisfy every assertion above on any tree.
    const samples = [
      "import { suppressionService } from './suppression.service';",
      "import { PipelineService } from '../services/pipeline.service';",
      'return global.suppressionList?.includes(email) || false;',
    ];
    const patterns = [
      /from\s+['"][^'"]*\/pipeline\.service['"]/,
      /from\s+['"][^'"]*\/suppression\.service['"]/,
      /global\s*\.\s*suppressionList|var\s+suppressionList/,
    ];
    for (const sample of samples) {
      expect(
        patterns.some((p) => p.test(sample)),
        `not detected: ${sample}`
      ).toBe(true);
    }
  });
});

describe('3. the retired outbox_messages table does not acquire a writer', () => {
  /**
   * P0.7 found the producer writing the POSTGRES table while the worker polled a different
   * store, so nothing enqueued there was ever consumed. Both moved onto the document store.
   *
   * The table is KEPT rather than dropped, because it may hold rows recording real mail from
   * the period when it was written, and dropping those to tidy a schema is not a trade worth
   * making. But it still reads as the live outbox — tenant index, idempotency constraint — so
   * the danger is that someone writes to it, the worker never sees it, and the message
   * silently never sends. That is P0.7 returning in a form that looks like working code.
   */
  it('nothing inserts into or updates it', () => {
    const WRITES = [
      /insert\s*\(\s*outboxMessages\s*\)/,
      /update\s*\(\s*outboxMessages\s*\)/,
      /delete\s*\(\s*outboxMessages\s*\)/,
      /from\s*\(\s*outboxMessages\s*\)/,
    ];
    for (const { path, code } of SOURCES) {
      for (const pattern of WRITES) {
        expect(
          code,
          `${path} uses the retired outbox_messages table. The live queue is ` +
            'server/services/outbox.service.ts, in the document store — see the note on the ' +
            'table in server/db/schema.ts.'
        ).not.toMatch(pattern);
      }
    }
  });

  it('the schema says so, where somebody reading the table will see it', () => {
    // A comment on the table, not in a document nobody opens. The failure mode is a developer
    // who greps `schema.ts` for "outbox" and writes to what they find.
    const schema = readFileSync('server/db/schema.ts', 'utf8');
    const note = schema.slice(0, schema.indexOf('export const outboxMessages'));
    expect(note.slice(-2000)).toContain('RETIRED');
    expect(note.slice(-2000)).toContain('outbox.service.ts');
  });

  it('that check would catch a real write', () => {
    const sample = "await db.insert(outboxMessages).values({ id, status: 'PENDING' });";
    expect(/insert\s*\(\s*outboxMessages\s*\)/.test(sample)).toBe(true);
  });
});
