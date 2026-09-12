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
    // Six more, found by the 2026-09-10 audit. None had a caller, and each one read, to anybody
    // searching for the concept, like the place that decision is made:
    //
    //   - `buyingStage.service.ts` — a second owner of stage transitions beside the OPPORTUNITY
    //     machine, switching on intent strings the intent union does not contain
    //     ('COMPLAINT', 'MEETING_CONFIRMED', 'CUSTOM_PRICING_REQUEST').
    //   - `nextBestAction.service.ts` — a second next-best-action decision, classifying questions
    //     with `includes('price')`, and answering SEND_PAYMENT_LINK above a readiness score.
    //   - `claimGrounding.service.ts` — returned a hardcoded "HIPAA and GDPR compliant" claim
    //     marked APPROVED, beside an auditor that found no unsupported claim in any draft. Wired to
    //     anything, it would have certified a compliance statement nothing in this repository
    //     supports.
    //   - `privacyOps.service.ts` — "anonymised" a contact by overwriting its name, email and
    //     phone, beside a comment conceding that messages and logs were never purged, and a
    //     retention job that only logged. An erasure that erases nothing is worse than none: it
    //     is the kind of record somebody later cites as proof that it happened.
    //   - `canary.service.ts` — imported by `inboundPipeline.ts` and never called. An import reads
    //     as a use; `tripCircuitBreaker` was the same shape.
    //   - `privacy.service.ts` — imported by `server.ts` and never called: a data-subject erasure
    //     and export whose four queries carried no organisation predicate, so a contact id from
    //     one tenant would have erased or exported a contact in another. Deleting it leaves this
    //     system with NO erasure or export path, which addendum-status.md records rather than
    //     keeping an unsafe one so the gap does not show.
    'server/services/buyingStage.service.ts',
    'server/services/nextBestAction.service.ts',
    'server/services/claimGrounding.service.ts',
    'server/services/privacyOps.service.ts',
    'server/services/canary.service.ts',
    'server/services/privacy.service.ts',
    // And one more, deleted with the injection work: it held a LIVE substring detector that
    // suppressed replies and a DEAD sanitiser that would have defeated five of the evasions
    // the detector missed. Both are now one normaliser in server/domain/promptInjection.ts.
    'server/services/aiSecurity.service.ts',
    // And three repository stubs. `server/repositories/` held contact, conversation and message
    // repositories with ZERO importers: a decomposition layer begun and never wired. The status
    // document has been describing this as "an empty directory", which is worse than the truth —
    // it was three files nothing called, the same shape as everything else in this list, and a
    // reader looking for where contacts are fetched would have found them.
    'server/repositories/contact.repository.ts',
    'server/repositories/conversation.repository.ts',
    'server/repositories/message.repository.ts',
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

  const AUDIT_2026_09_10 = [
    'buyingStage',
    'nextBestAction',
    'claimGrounding',
    'privacyOps',
    'canary',
    'privacy',
    'aiSecurity',
  ];
  const importOf = (name: string) => new RegExp(`from\\s+['"][^'"]*/${name}\\.service['"]`);

  it('nothing imports the six the 2026-09-10 audit found', () => {
    for (const { path, code } of SOURCES) {
      for (const name of AUDIT_2026_09_10) {
        expect(code, `${path} imports the deleted ${name}.service`).not.toMatch(importOf(name));
      }
    }
  });

  it('nothing imports the repository stubs either', () => {
    const importOfRepository = (name: string) =>
      new RegExp(`from\\s+['"][^'"]*/${name}\\.repository['"]`);

    for (const { path, code } of SOURCES) {
      for (const name of ['contact', 'conversation', 'message']) {
        expect(code, `${path} imports the deleted ${name}.repository`).not.toMatch(
          importOfRepository(name)
        );
      }
    }

    // And the rule itself catches what it is about.
    expect("import { contactRepository } from '../repositories/contact.repository';").toMatch(
      importOfRepository('contact')
    );
  });

  it('that import check would catch one of them coming back', () => {
    // The canary import is quoted exactly as it stood in inboundPipeline.ts.
    expect("import { CanaryRolloutService } from './canary.service';").toMatch(importOf('canary'));
    expect("import { privacyOpsService } from '../services/privacyOps.service';").toMatch(
      importOf('privacyOps')
    );
    // And does not fire on a module whose name merely BEGINS with a deleted one's.
    expect("import { policy } from '../services/nextBestActionPolicy.service';").not.toMatch(
      importOf('nextBestAction')
    );
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

/**
 * Two tables are retired, for different reasons, and guarded the same way.
 *
 * OUTBOX_MESSAGES — P0.7 found the producer writing the POSTGRES table while the worker polled a
 * different store, so nothing enqueued there was ever consumed. Both moved onto the document
 * store. The table is KEPT because it may hold rows recording real mail from the period when it
 * was written, and dropping those to tidy a schema is not a trade worth making.
 *
 * AI_RUN_LOGS — S22. The run log has been written to the document store since §1p, and the
 * relational table never had a writer at all: an endpoint, a shape and a schema that had never
 * met. No rows, so nothing to preserve; it stays only until S5 drops it with a migration that
 * has a rollback, which is the demonstration S5 is missing.
 *
 * Both still READ as the live thing — the outbox by its tenant index and idempotency constraint,
 * the run log by columns identical to the live log's — so the danger is the same: someone writes
 * to the table, the reader never sees it, and the write silently vanishes. That is P0.7
 * returning in a form that looks like working code. And a symbol that is merely IMPORTED is a
 * write waiting to happen, so importing one is refused too.
 */
const RETIRED = [
  { symbol: 'outboxMessages', table: 'outbox_messages', live: 'server/services/outbox.service.ts' },
  { symbol: 'campaignRecipients', table: 'campaign_recipients', live: 'server/services/campaignEngine.service.ts' },
  { symbol: 'quoteSnapshots', table: 'quote_snapshots', live: 'server/services/quote.service.ts' },
] as const;

/**
 * Retired, then DROPPED. `ai_run_logs` sat in this list from S22 until S5 wrote migration 0008 —
 * the contract step, with a reverse that recreates it. What is held now is stronger than
 * "retired": the symbol exists nowhere, and a migration drops the table.
 */
const DROPPED = [{ symbol: 'aiRunLogs', table: 'ai_run_logs', by: 'drizzle/0008_drop_ai_run_logs.sql' }] as const;

describe('3. the retired tables do not acquire a writer, a reader, or an importer', () => {
  for (const { symbol, table, live } of RETIRED) {
    const uses = ['insert', 'update', 'delete', 'from'].map(
      (verb) => new RegExp(verb + '\\s*\\(\\s*' + symbol + '\\s*\\)')
    );
    const mention = new RegExp('\\b' + symbol + '\\b');

    it(`nothing inserts into, updates, deletes from, or reads ${table}`, () => {
      for (const { path, code } of SOURCES) {
        for (const pattern of uses) {
          expect(
            code,
            `${path} uses the retired ${table} table. The live one is ${live}, in the document ` +
              'store — see the note on the table in server/db/schema.ts.'
          ).not.toMatch(pattern);
        }
      }
    });

    it(`nothing outside the schema so much as names ${symbol}`, () => {
      const importers = SOURCES.filter(
        ({ path, code }) => !path.replace(/\\/g, '/').endsWith('server/db/schema.ts') && mention.test(code)
      ).map(({ path }) => path);
      expect(importers, `${symbol} is in scope outside server/db/schema.ts`).toEqual([]);
    });

    it(`the schema says so, where somebody reading ${table} will see it`, () => {
      // A comment on the table, not in a document nobody opens. The failure mode is a developer
      // who greps `schema.ts` for the thing they need and writes to what they find.
      const schema = readFileSync('server/db/schema.ts', 'utf8');
      const declaration = schema.indexOf(`export const ${symbol} = pgTable(`);
      expect(declaration, `${symbol} is not declared in schema.ts`).toBeGreaterThan(-1);
      const note = schema.slice(0, declaration).slice(-2500);
      expect(note).toContain('RETIRED');
      expect(note).toContain(live.split('/').pop()!);
    });
  }

  for (const { symbol, table, by } of DROPPED) {
    it(`${table} is declared nowhere and dropped by ${by}`, () => {
      const mention = new RegExp('\b' + symbol + '\b');
      const anywhere = SOURCES.filter(({ code }) => mention.test(code)).map(({ path }) => path);
      expect(anywhere, `${symbol} is still declared or referenced`).toEqual([]);
      expect(readFileSync(by, 'utf8')).toMatch(new RegExp('DROP TABLE "' + table + '"'));
    });
  }

  it('those checks would catch a real write and a real import', () => {
    expect(/insert\s*\(\s*aiRunLogs\s*\)/.test("await db.insert(aiRunLogs).values({ id, status: 'SUCCESS' });")).toBe(true);
    expect(/\baiRunLogs\b/.test("import { contacts, aiRunLogs } from './db/schema';")).toBe(true);
    expect(/\baiRunLogs\b/.test('const view = store.aiRunLogsView;')).toBe(false);
  });
});
