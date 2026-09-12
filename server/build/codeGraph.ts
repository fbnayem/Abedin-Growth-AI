import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { blankComments } from './routeTable';

/**
 * S1 — the active code graph, derived from the tree rather than remembered about it.
 *
 * The previous graph was written by hand at audit time and was stale within days: it listed
 * modules that had since been deleted and omitted ten that had since been written, and a graph
 * that disagrees with the tree is worse than none. This one is derived: from the two runtime
 * entrypoints (`server.ts`, `src/main.tsx`) every import is followed — relative, `@/` alias,
 * dynamic — and a module is LIVE if a path of imports reaches it and DEAD if none does. The
 * scripts that package.json and the CI workflows invoke are entrypoints of their own and are
 * followed the same way, so a module reached only by a script is reported as operational, not as
 * live and not as dead; and a file under scripts/ that nothing names and nothing imports is
 * reported as reached by nothing, which is the unaccounted-for kind S1 was written about.
 *
 * What it cannot derive it does not claim: ownership of a capability is reported as "which live
 * modules import the provider" and "which live modules import the package", which is what the
 * code knows, and nothing here says who OUGHT to. The suite pins the answers it has decided.
 *
 * The rendering is deterministic (sorted, undated) so the committed copy can be regenerated and
 * compared; the suite refuses drift the way it does for the OpenAPI document.
 */

const ROOTS = ['server', 'src', 'shared'];
const EXTENSIONS = ['.ts', '.tsx'];
const SCRIPT_EXTENSIONS = ['.ts', '.mjs', '.cjs', '.js'];
const RUNTIME_ENTRYPOINTS = ['server.ts', 'src/main.tsx'];
const WORKFLOWS_DIR = '.github/workflows';
/** A code file under scripts/, as package.json commands and workflow steps write it. */
const SCRIPT_FILE = /\bscripts\/[\w./-]+\.(?:ts|mjs|cjs|js)\b/g;

export interface ModuleNode {
  /** Repo-relative, forward slashes. */
  readonly path: string;
  readonly imports: readonly string[];
  readonly packages: readonly string[];
}

/** A script file and the thing that runs it: `npm run <name>`, or a workflow file. */
export interface ScriptEntrypoint {
  readonly file: string;
  readonly invokedBy: string;
}

export interface CodeGraph {
  readonly modules: ReadonlyMap<string, ModuleNode>;
  /** Module -> the runtime entrypoints that reach it. */
  readonly reachableFrom: ReadonlyMap<string, Set<string>>;
  /** Module -> the invocations that reach it, for modules no runtime entrypoint reaches. */
  readonly operationalOnly: ReadonlyMap<string, Set<string>>;
  readonly dead: readonly string[];
  readonly scripts: readonly ScriptEntrypoint[];
  /** Code files under scripts/ that nothing names and no named script imports. */
  readonly orphanScripts: readonly string[];
}

const toPosix = (p: string) => p.split(sep).join('/');

function walk(dir: string, out: string[], root: string, extensions: readonly string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'tests' || entry === 'node_modules') continue;
      walk(full, out, root, extensions);
    } else if (extensions.some((e) => entry.endsWith(e)) && !entry.endsWith('.d.ts')) {
      out.push(toPosix(relative(root, full)));
    }
  }
}

/** Every module specifier a file imports, in source order: `import … from`, `export … from`, `import()`, `import '…'`. */
export function importSpecifiers(code: string): string[] {
  const blanked = blankComments(code);
  const out: string[] = [];
  for (const m of blanked.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of blanked.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of blanked.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/** Resolve a specifier from `fromFile` to a repo-relative module path, or null for a package or an asset. */
export function resolveSpecifier(spec: string, fromFile: string, root: string): string | null {
  let base: string;
  if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(root, dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = resolve(root, spec.slice(2));
  else return null;
  if (/\.(css|svg|png|jpe?g|json)$/i.test(base)) return null;
  const candidates = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => join(base, 'index' + e))];
  if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return toPosix(relative(root, c));
  }
  throw new Error(`[codeGraph] ${fromFile} imports '${spec}', which resolves to nothing under ${root}`);
}

function readModule(path: string, root: string): ModuleNode {
  const code = readFileSync(join(root, path), 'utf8');
  const imports: string[] = [];
  const packages: string[] = [];
  for (const spec of importSpecifiers(code)) {
    const target = resolveSpecifier(spec, path, root);
    if (target === null) {
      if (!/\.(css|svg|png|jpe?g|json)$/i.test(spec)) packages.push(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
    } else if (!imports.includes(target)) imports.push(target);
  }
  return { path, imports, packages: [...new Set(packages)].sort() };
}

function reach(entry: string, modules: Map<string, ModuleNode>, root: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const p = queue.pop()!;
    if (seen.has(p)) continue;
    seen.add(p);
    if (!modules.has(p)) modules.set(p, readModule(p, root));
    for (const i of modules.get(p)!.imports) if (!seen.has(i)) queue.push(i);
  }
  return seen;
}

/**
 * Every script file that package.json or a workflow under .github/workflows invokes, with what
 * invokes it. A command that names a file which does not exist is refused, not skipped: a script
 * entry pointing at nothing is a defect, and leaving it out would report the tree as tidier than
 * it is.
 */
export function scriptEntrypoints(root = '.'): ScriptEntrypoint[] {
  const out: ScriptEntrypoint[] = [];
  const add = (file: string, invokedBy: string, where: string) => {
    if (!existsSync(join(root, file))) throw new Error(`[codeGraph] ${where} names ${file}, which does not exist`);
    if (!out.some((s) => s.file === file && s.invokedBy === invokedBy)) out.push({ file, invokedBy });
  };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    for (const m of command.matchAll(SCRIPT_FILE)) add(m[0], `npm run ${name}`, `package.json script "${name}"`);
  }
  const workflows = join(root, WORKFLOWS_DIR);
  if (existsSync(workflows)) {
    for (const entry of readdirSync(workflows).filter((e) => /\.ya?ml$/.test(e)).sort()) {
      const text = readFileSync(join(workflows, entry), 'utf8');
      for (const m of text.matchAll(SCRIPT_FILE)) add(m[0], `${WORKFLOWS_DIR}/${entry}`, `${WORKFLOWS_DIR}/${entry}`);
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.invokedBy.localeCompare(b.invokedBy));
}

export function buildCodeGraph(root = '.'): CodeGraph {
  const modules = new Map<string, ModuleNode>();
  const reachableFrom = new Map<string, Set<string>>();
  for (const entry of RUNTIME_ENTRYPOINTS) {
    for (const p of reach(entry, modules, root)) {
      if (!reachableFrom.has(p)) reachableFrom.set(p, new Set());
      reachableFrom.get(p)!.add(entry);
    }
  }
  const scripts = scriptEntrypoints(root);
  const operationalOnly = new Map<string, Set<string>>();
  const reachedByScripts = new Set<string>();
  for (const { file, invokedBy } of scripts) {
    for (const p of reach(file, modules, root)) {
      reachedByScripts.add(p);
      if (reachableFrom.has(p) || p.startsWith('scripts/')) continue;
      if (!operationalOnly.has(p)) operationalOnly.set(p, new Set());
      operationalOnly.get(p)!.add(invokedBy);
    }
  }
  const all: string[] = [];
  for (const r of ROOTS) walk(join(root, r), all, root, EXTENSIONS);
  all.push('server.ts');
  const dead = all.filter((p) => !reachableFrom.has(p) && !operationalOnly.has(p)).sort();
  const scriptFiles: string[] = [];
  if (existsSync(join(root, 'scripts'))) walk(join(root, 'scripts'), scriptFiles, root, SCRIPT_EXTENSIONS);
  const orphanScripts = scriptFiles.filter((p) => !reachedByScripts.has(p)).sort();
  return { modules, reachableFrom, operationalOnly, dead, scripts, orphanScripts };
}

/** Provider modules whose live importers say who holds each external capability today. */
export const CAPABILITY_PROVIDERS: readonly { capability: string; module: string }[] = [
  { capability: 'Email send/read (Gmail)', module: 'server/services/gmail.service.ts' },
  { capability: 'Calendar', module: 'server/services/calendar.service.ts' },
  { capability: 'Outbound HTTP (fetch with timeout)', module: 'server/lib/httpClient.ts' },
  { capability: 'Model generation', module: 'server/geminiClient.ts' },
  { capability: 'Document store', module: 'server/store/index.ts' },
  { capability: 'Relational database', module: 'server/db/index.ts' },
  { capability: 'External side effects (the gateway)', module: 'server/gateway/actionGateway.ts' },
  { capability: 'Outbox queue', module: 'server/services/outbox.service.ts' },
];

/** Package -> the live modules outside src/ that import it. Node built-ins are not packages. */
export function serverPackageImporters(graph: CodeGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of [...graph.reachableFrom.keys()].sort()) {
    if (p.startsWith('src/')) continue;
    for (const pkg of graph.modules.get(p)!.packages) {
      if (pkg.startsWith('node:') || builtinModules.includes(pkg)) continue;
      if (!out.has(pkg)) out.set(pkg, []);
      out.get(pkg)!.push(p);
    }
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function byDirectory(paths: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '(root)';
    if (!out.has(dir)) out.set(dir, []);
    out.get(dir)!.push(p);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function renderCodeGraph(graph: CodeGraph): string {
  const live = [...graph.reachableFrom.keys()].sort();
  const importers = (target: string) => live.filter((p) => graph.modules.get(p)!.imports.includes(target)).sort();
  const code = (s: string) => `\`${s}\``;
  const lines: string[] = [];
  const push = (s = '') => lines.push(s);

  push('# Active Code Graph');
  push();
  push('**Generated** by `scripts/generate-code-graph.ts` from `server/build/codeGraph.ts`. Do not edit; regenerate with `npm run code-graph`.');
  push('`codeGraph.invariant.test.ts` regenerates this file and refuses any difference from the committed copy, so it cannot describe a tree other than the one it is committed with.');
  push();
  push('## 1. How this is derived');
  push();
  push(`Every import is followed from the runtime entrypoints — ${RUNTIME_ENTRYPOINTS.map(code).join(' and ')} — relative, \`@/\` alias and dynamic alike, with comments blanked by the same scanner the route table uses.`);
  push(`A module is **live** if a path of imports reaches it from a runtime entrypoint, **operational** if only a script invoked by package.json or a workflow under \`${WORKFLOWS_DIR}\` reaches it, and **dead** if nothing does.`);
  push('Capability ownership is reported as *which live modules import the provider*, and the dependency surface as *which live modules import the package*: that is what the code knows. Nothing here says who ought to.');
  push();
  push('## 2. Entrypoints');
  push();
  push('| Entrypoint | Live modules reached |');
  push('|---|---|');
  for (const e of RUNTIME_ENTRYPOINTS) push(`| ${code(e)} | ${live.filter((p) => graph.reachableFrom.get(p)!.has(e)).length} |`);
  push();
  push(`Live modules in total: **${live.length}**. Dead files: **${graph.dead.length}**. Operational-only modules: **${graph.operationalOnly.size}**. Script invocations: **${graph.scripts.length}**. Scripts reached by nothing: **${graph.orphanScripts.length}**.`);
  push();
  push('## 3. Capability providers and their live importers');
  push();
  push('| Capability | Provider module | Live importers |');
  push('|---|---|---|');
  for (const { capability, module } of CAPABILITY_PROVIDERS) {
    const who = graph.reachableFrom.has(module) ? importers(module) : [];
    const status = graph.reachableFrom.has(module) ? who.map(code).join(', ') || '(imported by nothing live)' : '(provider not live)';
    push(`| ${capability} | ${code(module)} | ${status} |`);
  }
  push();
  push('## 4. Packages imported by live server modules');
  push();
  push("The server's dependency surface by importer: every package a live module outside `src/` imports, and which modules import it. Node built-ins are omitted.");
  push();
  push('| Package | Live importers |');
  push('|---|---|');
  for (const [pkg, who] of serverPackageImporters(graph)) push(`| ${code(pkg)} | ${who.map(code).join(', ')} |`);
  push();
  push('## 5. Live modules by directory');
  push();
  for (const [dir, paths] of byDirectory(live)) {
    push(`### ${dir}`);
    push();
    push('| Module | Imported by (live) | Reached from |');
    push('|---|---|---|');
    for (const p of paths.sort()) {
      const from = [...graph.reachableFrom.get(p)!].sort().map((e) => e.split('/').pop()).join(', ');
      push(`| ${code(p)} | ${importers(p).length} | ${from} |`);
    }
    push();
  }
  push('## 6. Operational-only modules');
  push();
  if (graph.operationalOnly.size === 0) push('None: every module a script reaches is also live.');
  else {
    push('| Module | Reached only by |');
    push('|---|---|');
    for (const [p, names] of [...graph.operationalOnly.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      push(`| ${code(p)} | ${[...names].sort().map(code).join(', ')} |`);
    }
  }
  push();
  push('## 7. Dead files');
  push();
  if (graph.dead.length === 0) push('None: every `.ts`/`.tsx` file under `server/`, `src/` and `shared/` (tests excluded) is reached from a runtime entrypoint or a script.');
  else {
    push('Present in the tree, reached by nothing. Each is either to be deleted or to be wired; a file that stays here across two regenerations is a decision nobody made.');
    push();
    for (const p of graph.dead) push(`- ${code(p)}`);
  }
  push();
  push('## 8. Scripts reached by nothing');
  push();
  if (graph.orphanScripts.length === 0) push(`None: every code file under \`scripts/\` is named by a package.json script or a workflow under \`${WORKFLOWS_DIR}\`, or is imported by one that is.`);
  else {
    push(`Code files under \`scripts/\` that no package.json script or workflow under \`${WORKFLOWS_DIR}\` names, and that no named script imports. A script only a comment knows how to run is the unaccounted-for kind S1 was written about.`);
    push();
    for (const p of graph.orphanScripts) push(`- ${code(p)}`);
  }
  push();
  push('## 9. Frontend imports of server code');
  push();
  const cross = live.filter((p) => p.startsWith('src/')).flatMap((p) => graph.modules.get(p)!.imports.filter((i) => i.startsWith('server/')).map((i) => `${code(p)} -> ${code(i)}`));
  if (cross.length === 0) push('None (S40 holds: no file under `src/` imports from `server/`).');
  else for (const c of cross) push(`- ${c}`);
  push();
  return lines.join('\n') + '\n';
}

export const CODE_GRAPH_PATH = 'docs/production/active-code-graph.md';
