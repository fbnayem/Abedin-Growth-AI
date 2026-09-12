import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S11 — the routes this server registers, read from the source that registers them.
 *
 * An OpenAPI document that lists what somebody remembered to write down is a second copy of the
 * route table, and second copies drift. This reads the first copy: every `app.<method>("/api/...")`
 * in server.ts, every router mounted with `app.use(prefix, xRouter)` and every route that router
 * declares, and reports for each whether its handler reads a body and whether that body arrives
 * raw. The document is generated from this; the suite compares the document against this; and a
 * route this cannot read STOPS the caller rather than being silently absent from both.
 *
 * Deliberately narrow. It reads the forms this codebase uses — a string-literal path on the same
 * line as the method — and throws on any registration whose count it cannot reconcile, because
 * a table that quietly omits a route is worse than none.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteEntry {
  readonly method: HttpMethod;
  /** Express form, `:param` included. */
  readonly path: string;
  /** `server.ts` or `server/routes/<file>`. */
  readonly source: string;
  readonly line: number;
  /** The handler's text mentions `req.body`. What it does with it is the contract registry's business. */
  readonly readsBody: boolean;
  /** The path is served a raw (unparsed) body by `express.raw` middleware. */
  readonly rawBody: boolean;
}

/**
 * Replace comments with spaces of equal length so indexes and line numbers survive.
 *
 * A scanner, not a regex: server.ts contains the string `'*\/*'` (a raw-body content type), and a
 * regex that opens a block comment at the `/*` inside it blanks everything to the next `*\/` —
 * eighty lines that include the router mounts. String literals are skipped as strings.
 */
export function blankComments(code: string): string {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '"' || c === "'" || c === '`') {
      // Skip a string literal, honouring escapes; template literals may span lines.
      const quote = c;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && code[i] !== '\n') out[i++] = ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return out.join('');
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

const METHODS = 'get|post|put|patch|delete';
/**
 * A handler reads a body if it touches `req.body`, or hands it to one of the two validators —
 * which read `req.body` on its behalf. Until 2026-09-12 only the first counted, so a route that
 * validated everything it read was reported as reading nothing.
 */
const READS_BODY = /\breq\.body\b|\bparsedBodyOr400\(|\bparseOrRespond\(/;

/** Exported for the suite: the refusal on an unreadable registration is a behaviour, not a comment. */
export function inlineRoutes(server: string, rawPaths: Set<string>): RouteEntry[] {
  // Any literal path, not only `/api/...`: the SPA catch-all `app.get("*")` is a registration
  // too, and a count that ignored it could not tell it from a route it failed to read. The
  // document builder is what confines itself to the API.
  const literal = new RegExp(`app\\.(${METHODS})\\(\\s*"([^"]+)"`, 'g');
  const any = new RegExp(`app\\.(${METHODS})\\(`, 'g');
  const found = [...server.matchAll(literal)];
  const total = (server.match(any) ?? []).length;
  if (found.length !== total) {
    throw new Error(
      `[routeTable] server.ts registers ${total} route(s) but ${found.length} have a literal path ` +
        'on the registration line. A route this cannot read would be missing from the document.'
    );
  }
  return found.map((m, i) => {
    const start = m.index!;
    const nextRegistration = i + 1 < found.length ? found[i + 1].index! : server.length;
    return {
      method: m[1].toUpperCase() as HttpMethod,
      path: m[2],
      source: 'server.ts',
      line: lineAt(server, start),
      readsBody: READS_BODY.test(handlerText(server, start, nextRegistration, '  ')),
      rawBody: rawPaths.has(m[2]),
    };
  });
}

/**
 * The text of ONE handler. An inline arrow ends at the registration's own `});` at the
 * registration's indent (two spaces inside `startServer`, none in a router file) — not at the
 * next registration, because helper functions declared between two routes would otherwise be
 * read as part of the earlier one. A named handler (`app.post(path, fn)`) is followed to its
 * declaration — `function fn(` or `const fn = async (` — and read to its closing brace at the
 * same indent.
 *
 * The `const fn = async (` form was not followed until 2026-09-12: `setCampaignStatus` and
 * `setOpportunityStage` are arrows, so the four routes they serve were read as their one
 * registration line, which does not mention `req.body`, and reported as reading no body.
 */
function handlerText(code: string, start: number, nextRegistration: number, indent: string): string {
  const registration = code.slice(start, code.indexOf('\n', start));
  const named = /,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\);\s*$/.exec(registration);
  if (named) {
    const decl = new RegExp(
      `(?:(?:async\\s+)?function\\s+${named[1]}\\s*\\(|const\\s+${named[1]}\\s*=\\s*(?:async\\s*)?\\()`
    ).exec(code);
    if (!decl) return registration;
    const bodyEnd = code.indexOf(`\n${indent}}`, decl.index);
    return code.slice(decl.index, bodyEnd === -1 ? code.length : bodyEnd + indent.length + 2);
  }
  const close = code.indexOf(`\n${indent}});`, start);
  const end = close === -1 || close > nextRegistration ? nextRegistration : close + indent.length + 4;
  return code.slice(start, end);
}

function rawBodyPaths(server: string): Set<string> {
  return new Set([...server.matchAll(/app\.use\(\s*'([^']+)',\s*express\.raw\(/g)].map((m) => m[1]));
}

/** `app.use(<prefix>, xRouter)`; a prefix may be a literal or an imported constant. */
function mounts(server: string, root: string): { prefix: string; router: string; line: number }[] {
  const rx = /app\.use\(\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*([A-Za-z]+Router)\s*\)/g;
  return [...server.matchAll(rx)].map((m) => {
    const literal = m[1] ?? m[2];
    const constant = m[3];
    const prefix = literal ?? resolveConstant(server, constant!, root);
    return { prefix, router: m[4], line: lineAt(server, m.index!) };
  });
}

/** Follow `import { NAME } from "./server/x"` to `export const NAME = '...'`. */
function resolveConstant(server: string, name: string, root: string): string {
  const imp = new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "\\./([^"]+)"`).exec(server);
  if (!imp) throw new Error(`[routeTable] mount prefix ${name} is not a literal and not an import`);
  const file = join(root, imp[1] + '.ts');
  const def = new RegExp(`export const ${name} = '([^']+)'`).exec(readFileSync(file, 'utf8'));
  if (!def) throw new Error(`[routeTable] ${name} is not a string constant in ${imp[1]}.ts`);
  return def[1];
}

function routerFile(router: string, root: string): { file: string; code: string } {
  const dir = join(root, 'server', 'routes');
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.routes.ts')) continue;
    const code = readFileSync(join(dir, name), 'utf8');
    // `export const x = Router()`, `const x = express.Router()` with the export elsewhere, either.
    if (new RegExp(`(?:export\\s+)?const ${router}(?:\\s*:\\s*Router)?\\s*=\\s*(?:express\\.)?Router\\(\\)`).test(code)) {
      return { file: `server/routes/${name}`, code: blankComments(code.replace(/\r\n/g, '\n')) };
    }
  }
  throw new Error(`[routeTable] no file under server/routes exports ${router}`);
}

function routerRoutes(mount: { prefix: string; router: string }, root: string): RouteEntry[] {
  const { file, code } = routerFile(mount.router, root);
  const literal = new RegExp(`${mount.router}\\.(${METHODS})\\(\\s*'([^']+)'`, 'g');
  const any = new RegExp(`${mount.router}\\.(${METHODS})\\(`, 'g');
  const found = [...code.matchAll(literal)];
  const total = (code.match(any) ?? []).length;
  if (found.length !== total) {
    throw new Error(`[routeTable] ${file} declares ${total} route(s) but ${found.length} have a literal path`);
  }
  return found.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < found.length ? found[i + 1].index! : code.length;
    const sub = m[2] === '/' ? '' : m[2];
    const registrationLine = code.slice(start, code.indexOf('\n', start));
    return {
      method: m[1].toUpperCase() as HttpMethod,
      path: mount.prefix + sub,
      source: file,
      line: lineAt(code, start),
      readsBody: READS_BODY.test(handlerText(code, start, end, '')),
      // A router may parse raw on the route itself (the Stripe webhook does): the registration
      // line carries `express.raw(` and the body the handler reads is the bytes the provider signed.
      rawBody: /express\.raw\(/.test(registrationLine),
    };
  });
}

export function routeTable(root = '.'): RouteEntry[] {
  const server = blankComments(readFileSync(join(root, 'server.ts'), 'utf8').replace(/\r\n/g, '\n'));
  const raw = rawBodyPaths(server);
  const entries = [...inlineRoutes(server, raw)];
  for (const mount of mounts(server, root)) {
    // Raw on the app for that path, or raw on the route itself: either makes the body raw.
    for (const r of routerRoutes(mount, root)) entries.push({ ...r, rawBody: r.rawBody || raw.has(r.path) });
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const key = `${e.method} ${e.path}`;
    if (seen.has(key)) throw new Error(`[routeTable] ${key} is registered twice`);
    seen.add(key);
  }
  return entries.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}

/**
 * The text of a route's handler, read the way the table read it — for a suite that checks a
 * claim (a contract, a refusal) against the handler rather than against the file around it.
 * Since S39 the handler may sit in a router and may be a named arrow declared above its
 * registration; a suite slicing forward from the registration line would miss it.
 */
export function handlerTextOf(entry: RouteEntry, root = '.'): string {
  const code = blankComments(readFileSync(join(root, entry.source), 'utf8').replace(/\r\n/g, '\n'));
  const lines = code.split('\n');
  const start = lines.slice(0, entry.line - 1).join('\n').length + (entry.line > 1 ? 1 : 0);
  const inline = entry.source === 'server.ts';
  const next = new RegExp(`${inline ? 'app' : '[A-Za-z]+Router'}\\.(${METHODS})\\(`, 'g');
  // From the END of the registration line: a search from one character in re-finds the same
  // registration, since `[A-Za-z]+Router` also matches its own tail.
  next.lastIndex = code.indexOf('\n', start);
  const following = next.exec(code);
  return handlerText(code, start, following ? following.index : code.length, inline ? '  ' : '');
}

/** `/api/x/:id/y` -> `/api/x/{id}/y`, and the parameter names in order. */
export function openApiPath(expressPath: string): { path: string; params: string[] } {
  const params: string[] = [];
  const path = expressPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path, params };
}
