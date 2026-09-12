import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodeGraph,
  renderCodeGraph,
  importSpecifiers,
  resolveSpecifier,
  scriptEntrypoints,
  serverPackageImporters,
  CODE_GRAPH_PATH,
  CAPABILITY_PROVIDERS,
} from '../build/codeGraph';

/**
 * THE CODE GRAPH IS DERIVED, AND CANNOT DISAGREE WITH THE TREE (S1).
 *
 * The hand-written graph listed modules that had been deleted and omitted ten that had been
 * written. This one is generated from the imports, committed, and regenerated here: a difference
 * fails the gate. The scanner is proved on a synthetic tree so its rules — which forms of import
 * it follows, what it refuses — are behaviours rather than descriptions. And the three things S1
 * named — dead modules, competing owners, scripts nothing accounts for — are each an assertion
 * here, not a paragraph: the tree has no dead file, each external capability has the owners this
 * suite says and no other, and every script is named by something that runs it.
 */

const graph = buildCodeGraph();
const committed = readFileSync(CODE_GRAPH_PATH, 'utf8').replace(/\r\n/g, '\n');
const liveImporters = (target: string) =>
  [...graph.reachableFrom.keys()].filter((p) => graph.modules.get(p)!.imports.includes(target)).sort();

/**
 * Who may import each external capability. Exact, and edited by hand: a module that starts
 * importing the Gmail adapter or the model client is a new owner of that capability, which is a
 * decision to record here, not a side effect of a merge. The list may shrink without ceremony.
 */
const OWNERS: Record<string, string[]> = {
  'server/services/gmail.service.ts': [
    'server/gateway/actionGateway.ts',
    'server/services/gmailHistorySync.service.ts',
    'server/services/inboundPipeline.ts',
  ],
  'server/services/calendar.service.ts': ['server/gateway/actionGateway.ts'],
  'server/lib/httpClient.ts': [
    'server/gateway/actionGateway.ts',
    // Imports the timeout error class to classify it; performs no request.
    'server/lib/providerError.ts',
    'server/services/calendar.service.ts',
    'server/services/gmail.service.ts',
  ],
  'server/geminiClient.ts': [
    'server/agents/companyBrainAgent.ts',
    'server/agents/conversationMemoryAgent.ts',
    'server/agents/growthCommandAgent.ts',
    'server/agents/pitchBattleAgent.ts',
    'server/agents/salesDecisionEngine.ts',
  ],
  'server/gateway/actionGateway.ts': [
    // Imports the fabricated-credential predicate; dispatches nothing.
    'server/routes/integrations.routes.ts',
    // The live booking path: CALENDAR_CREATE is dispatched from here.
    'server/routes/meetings.routes.ts',
    'server/workers/outbox.worker.ts',
  ],
  'server/services/outbox.service.ts': [
    'server/gateway/actionGateway.ts',
    'server/routes/outbox.routes.ts',
    'server/services/circuitBreaker.service.ts',
    'server/services/inboundPipeline.ts',
    'server/workers/outbox.worker.ts',
  ],
};

/** The SDKs that reach the outside world, and the one place each is allowed to be constructed. */
const PACKAGE_OWNERS: Record<string, string[]> = {
  '@google/genai': ['server/geminiClient.ts'],
  'stripe': ['server/routes/stripe.routes.ts'],
  'firebase-admin': ['server/firebase.ts'],
  'pg': ['server/db/index.ts', 'server/store/index.ts'],
};

// =============================================================================================
describe('1. the committed graph is what the tree generates', () => {
  it('THE INVARIANT — regenerating yields the committed copy', () => {
    expect(renderCodeGraph(graph), `${CODE_GRAPH_PATH} is stale. Run: npm run code-graph`).toBe(committed);
  });

  it('the graph reaches the modules this system is known to run on', () => {
    for (const live of [
      'server/gateway/actionGateway.ts',
      'server/services/outbox.service.ts',
      'server/workers/outbox.worker.ts',
      'server/services/circuitBreaker.service.ts',
      'server/build/openapi.ts',
      'src/App.tsx',
      'shared/domain/pricing.ts',
    ]) {
      expect(graph.reachableFrom.has(live), `${live} should be live`).toBe(true);
    }
    expect(graph.reachableFrom.get('src/App.tsx')!.has('src/main.tsx')).toBe(true);
    expect(graph.reachableFrom.get('server/gateway/actionGateway.ts')!.has('server.ts')).toBe(true);
  });

  it('no file under src/ imports from server/ (S40), as the graph reports', () => {
    for (const [p, node] of graph.modules) {
      if (!p.startsWith('src/')) continue;
      expect(node.imports.filter((i) => i.startsWith('server/')), p).toEqual([]);
    }
    expect(committed).toContain('None (S40 holds');
  });

  it('every capability provider is live and has at least one live importer', () => {
    for (const { module } of CAPABILITY_PROVIDERS) {
      expect(graph.reachableFrom.has(module), module).toBe(true);
      expect(liveImporters(module).length, `${module} is imported by nothing live`).toBeGreaterThan(0);
    }
  });

  it('THE INVARIANT — no dead file: everything under server/, src/ and shared/ is reached by something', () => {
    // Ten dead files were deleted on 2026-09-12 (eight agents nothing called, a policy nothing
    // read, a component nothing rendered). From here a file nothing reaches fails the gate: it is
    // either deleted or wired, and the tree cannot carry it as an undecided thing.
    expect(graph.dead, 'reached by nothing — delete it or wire it').toEqual([]);
    expect(committed).toContain('Dead files: **0**');
  });

  it('THE INVARIANT — every live and operational module is tracked by git', () => {
    // Found 2026-09-12: an unanchored `build/` in .gitignore matched server/build/, and three
    // modules server.ts imports had never been committed. Every gate ran in the working tree
    // that had them, so every gate passed, and a fresh clone did not compile. A module that is
    // reachable from an entrypoint and absent from git is that defect, whatever the pattern.
    const tracked = new Set(execSync('git ls-files', { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
    const reachable = [...graph.reachableFrom.keys(), ...graph.operationalOnly.keys()].sort();
    const untracked = reachable.filter((p) => !tracked.has(p));
    expect(untracked, 'reachable from an entrypoint but not in git — a clone would not compile').toEqual([]);
    expect(tracked.size).toBeGreaterThan(100);
  });
});

// =============================================================================================
describe('2. owners: each external capability is held by the modules this suite names, and no other', () => {
  for (const [provider, owners] of Object.entries(OWNERS)) {
    it(`THE INVARIANT — ${provider} is imported by exactly its recorded owners`, () => {
      const actual = liveImporters(provider);
      const added = actual.filter((p) => !owners.includes(p));
      const gone = owners.filter((p) => !actual.includes(p));
      expect(added, `new importer(s) of ${provider} — a new owner of that capability is a decision; record it in OWNERS or route through the existing one`).toEqual([]);
      expect(gone, `recorded owner(s) of ${provider} no longer import it — shrink OWNERS`).toEqual([]);
    });
  }

  for (const [pkg, owners] of Object.entries(PACKAGE_OWNERS)) {
    it(`THE INVARIANT — the ${pkg} SDK is constructed only in ${owners.join(', ')}`, () => {
      // Found by this table on 2026-09-12: pitchBattleAgent built its own GoogleGenAI and called
      // the model past geminiClient, where S22's run log and S37's cost ledger live — an
      // unaccounted model call. It goes through the client now; a second SDK owner fails here.
      const actual = serverPackageImporters(graph).get(pkg) ?? [];
      expect(actual, `${pkg} importers`).toEqual([...owners].sort());
    });
  }

  it('the pinned owners are all live modules, so the pins cannot be satisfied by a dead one', () => {
    for (const owner of [...Object.values(OWNERS).flat(), ...Object.values(PACKAGE_OWNERS).flat()]) {
      expect(graph.reachableFrom.has(owner), owner).toBe(true);
    }
  });
});

// =============================================================================================
describe('3. scripts: every file under scripts/ is named by something that runs it', () => {
  it('package.json scripts and CI workflow steps are the script entrypoints', () => {
    const scripts = scriptEntrypoints();
    const has = (file: string, invokedBy: string) => scripts.some((s) => s.file === file && s.invokedBy === invokedBy);
    expect(has('scripts/migrate.ts', 'npm run migrate')).toBe(true);
    expect(has('scripts/db-rollback.ts', 'npm run db:rollback')).toBe(true);
    expect(has('scripts/generate-openapi.ts', 'npm run openapi')).toBe(true);
    expect(has('scripts/generate-code-graph.ts', 'npm run code-graph')).toBe(true);
    // Invoked by CI and by no package.json script: an entrypoint all the same.
    expect(has('scripts/check-build-provenance.mjs', '.github/workflows/ci.yml')).toBe(true);
    expect(has('scripts/check-dependency-advisories.mjs', '.github/workflows/ci.yml')).toBe(true);
    // Three operator tools that only a comment knew how to run, named on 2026-09-12.
    expect(has('scripts/db-apply.ts', 'npm run db:apply')).toBe(true);
    expect(has('scripts/backfill-outbox-version.ts', 'npm run outbox:backfill-version')).toBe(true);
    expect(has('scripts/set-org-claim.mjs', 'npm run org:claim')).toBe(true);
  });

  it('THE INVARIANT — no script is reached by nothing', () => {
    expect(graph.orphanScripts, 'under scripts/, named by no package.json script or workflow, imported by none that is').toEqual([]);
    expect(committed).toContain('Scripts reached by nothing: **0**');
  });

  it('scripts/lib is reached through the scripts that import it, not named directly', () => {
    expect(graph.orphanScripts).not.toContain('scripts/lib/migration-reverse.ts');
    expect(scriptEntrypoints().some((s) => s.file.startsWith('scripts/lib/'))).toBe(false);
  });
});

// =============================================================================================
describe('4. the scanner follows every import form this tree uses, and refuses what it cannot resolve', () => {
  it('reads static, re-export, side-effect and dynamic imports; ignores commented-out ones', () => {
    const code = [
      "import a from './a';",
      "import { b, type B } from '../b.ts';",
      "export { c } from '@/shared/c';",
      "import './styles.css';",
      "const d = await import('./d');",
      "// import e from './e';",
      "/* import f from './f'; */",
      // The two forms blanking exists for. A line-start regex never matched `// import` or
      // `/* import`; a block comment whose inner line begins with `import`, and a dynamic
      // `import()` anywhere on a commented-out line, are the ones an unblanked scan follows.
      "/*\nimport f2 from './f2';\n*/",
      "// const z = await import('./z');",
      "const s = \"import g from './g'\";",
    ].join('\n');
    expect(importSpecifiers(code)).toEqual(['./a', '../b.ts', '@/shared/c', './styles.css', './d']);
  });

  it('resolves relative and alias specifiers to files, tries extensions and index, and skips assets and packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-'));
    try {
      mkdirSync(join(root, 'lib'));
      mkdirSync(join(root, 'dir'));
      writeFileSync(join(root, 'lib', 'a.ts'), '');
      writeFileSync(join(root, 'dir', 'index.tsx'), '');
      writeFileSync(join(root, 'entry.ts'), '');
      expect(resolveSpecifier('./lib/a', 'entry.ts', root)).toBe('lib/a.ts');
      expect(resolveSpecifier('./lib/a.ts', 'entry.ts', root)).toBe('lib/a.ts');
      expect(resolveSpecifier('./dir', 'entry.ts', root)).toBe('dir/index.tsx');
      expect(resolveSpecifier('@/lib/a', 'dir/index.tsx', root)).toBe('lib/a.ts');
      expect(resolveSpecifier('../lib/a', 'dir/index.tsx', root)).toBe('lib/a.ts');
      expect(resolveSpecifier('./index.css', 'entry.ts', root)).toBeNull();
      expect(resolveSpecifier('express', 'entry.ts', root)).toBeNull();
      expect(() => resolveSpecifier('./missing', 'entry.ts', root)).toThrow(/resolves to nothing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a synthetic tree: live, operational-only, dead, CI-invoked and orphan scripts are told apart', () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-'));
    try {
      for (const d of ['server', 'src', 'shared', 'scripts', 'scripts/lib', '.github', '.github/workflows']) mkdirSync(join(root, d));
      writeFileSync(join(root, 'server.ts'), "import './server/live';\nimport pg from 'pg';");
      writeFileSync(join(root, 'server', 'live.ts'), "import '../shared/both';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'path';");
      writeFileSync(join(root, 'shared', 'both.ts'), '');
      writeFileSync(join(root, 'src', 'main.tsx'), "import './App';");
      writeFileSync(join(root, 'src', 'App.tsx'), "import '../shared/both';\nimport pg from 'pg';");
      writeFileSync(join(root, 'server', 'dead.ts'), "import './live';");
      writeFileSync(join(root, 'server', 'toolOnly.ts'), '');
      writeFileSync(join(root, 'scripts', 'tool.ts'), "import '../server/toolOnly';\nimport './lib/helper.mjs';");
      writeFileSync(join(root, 'scripts', 'lib', 'helper.mjs'), '');
      writeFileSync(join(root, 'scripts', 'ci-only.mjs'), '');
      writeFileSync(join(root, 'scripts', 'orphan.ts'), '');
      writeFileSync(join(root, 'scripts', 'notes.sql'), '-- not code');
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { tool: 'tsx scripts/tool.ts' } }));
      writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: node scripts/ci-only.mjs\n  - run: node scripts/tool.ts --check\n');
      const g = buildCodeGraph(root);
      expect([...g.reachableFrom.keys()].sort()).toEqual(['server.ts', 'server/live.ts', 'shared/both.ts', 'src/App.tsx', 'src/main.tsx']);
      expect([...g.reachableFrom.get('shared/both.ts')!].sort()).toEqual(['server.ts', 'src/main.tsx']);
      expect([...g.operationalOnly.keys()]).toEqual(['server/toolOnly.ts']);
      expect([...g.operationalOnly.get('server/toolOnly.ts')!].sort()).toEqual(['.github/workflows/ci.yml', 'npm run tool']);
      // dead.ts imports a live module; that makes nothing reach dead.ts.
      expect(g.dead).toEqual(['server/dead.ts']);
      expect(g.scripts).toEqual([
        { file: 'scripts/ci-only.mjs', invokedBy: '.github/workflows/ci.yml' },
        { file: 'scripts/tool.ts', invokedBy: '.github/workflows/ci.yml' },
        { file: 'scripts/tool.ts', invokedBy: 'npm run tool' },
      ]);
      // helper.mjs is reached through tool.ts; orphan.ts by nothing; notes.sql is not code.
      expect(g.orphanScripts).toEqual(['scripts/orphan.ts']);
      // The package table counts server-side importers only, and built-ins are not packages.
      expect([...serverPackageImporters(g).entries()]).toEqual([['pg', ['server.ts']]]);
      const md = renderCodeGraph(g);
      expect(md).toContain('- `server/dead.ts`');
      expect(md).toContain('- `scripts/orphan.ts`');
      expect(md).toContain('`server/toolOnly.ts` | `.github/workflows/ci.yml`, `npm run tool`');
      expect(md).toContain('| `pg` | `server.ts` |');
      expect(md).toContain('Scripts reached by nothing: **1**');
      // A script entry that names a file which does not exist is refused, not skipped.
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { ghost: 'tsx scripts/ghost.ts' } }));
      expect(() => buildCodeGraph(root)).toThrow(/package\.json script "ghost" names scripts\/ghost\.ts, which does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
