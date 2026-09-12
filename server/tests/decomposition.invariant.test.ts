import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { blankComments, inlineRoutes, routeTable, handlerTextOf } from '../build/routeTable';
import { memory } from './helpers/memoryDocumentStore';
import { setCampaignStatus } from '../routes/campaigns.routes';
import { setOpportunityStage } from '../routes/pipeline.routes';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * THE MONOLITH IS DECOMPOSED, AND STAYS DECOMPOSED (S39).
 *
 * server.ts registered seventy-two API routes inline, inside one two-thousand-line function,
 * and twenty-three suites pinned their text there. On 2026-09-12 every one moved into a router
 * under server/routes, mounted from server.ts, and the suites followed them. What this suite
 * holds is the shape, not a line count: no API route is registered inline, every router file
 * is mounted, every mount has a file, and the guardrails that read server.ts read the routers.
 *
 * It also holds the eight fixed answers that survived the P1.13 pass — `{ intentConfidence:
 * 0.9 }`, `{ decision: "Proceed" }`, a placeholder sender identity — as refusals, by reading
 * each handler through the same reader the route table uses.
 */

const server = blankComments(readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n'));
const table = routeTable();
const routerFiles = readdirSync('server/routes').filter((f) => f.endsWith('.routes.ts'));

// =============================================================================================
describe('1. server.ts mounts routers and registers no API route itself', () => {
  it('THE INVARIANT — the only inline registration is the SPA catch-all', () => {
    const inline = inlineRoutes(server, new Set());
    expect(inline.map((r) => `${r.method} ${r.path}`)).toEqual(['GET *']);
  });

  it('every API route in the table comes from a file under server/routes', () => {
    for (const r of table.filter((r) => r.path.startsWith('/api'))) {
      expect(r.source, `${r.method} ${r.path}`).toMatch(/^server\/routes\/[A-Za-z]+\.routes\.ts$/);
    }
    expect(table.filter((r) => r.path.startsWith('/api')).length).toBeGreaterThanOrEqual(88);
  });

  it('THE INVARIANT — every router file is mounted exactly once, and every mount names a router that exists', () => {
    const mounts = [...server.matchAll(/app\.use\(\s*(?:"[^"]+"|'[^']+'|[A-Za-z_]+)\s*,\s*([A-Za-z]+Router)\s*\)/g)].map((m) => m[1]);
    const exported = routerFiles.map((f) => {
      // `export const x = Router()`, or a declaration exported separately (the Stripe router).
      const m = /const ([A-Za-z]+Router)\s*(?::\s*Router)?\s*=\s*(?:express\.)?Router\(\)/.exec(readFileSync(`server/routes/${f}`, 'utf8'));
      if (!m) throw new Error(`${f} exports no router`);
      return m[1];
    });
    for (const name of exported) {
      expect(mounts.filter((x) => x === name), `${name} mounted`).toHaveLength(1);
    }
    for (const name of mounts) expect(exported, `${name} has a file`).toContain(name);
    expect(routerFiles.length).toBeGreaterThanOrEqual(24);
  });

  it('THE INVARIANT — the first import of server.ts loads .env, because the modules after it read the environment as they evaluate', () => {
    // `server/config/environment.ts` reads DATABASE_URL when it is evaluated, and ES imports are
    // evaluated in source order before this file's own statements. The mechanical move pruned
    // the named import of safeMode (its exports had gone to the health router) and with it the
    // ordering: the store initialised with no URL and the running server refused every
    // tenant-scoped request. The gate did not see it; a booted server did.
    const raw = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n');
    const firstImport = raw.split('\n').find((line) => /^import\s/.test(line));
    expect(firstImport).toBe("import './server/config/safeMode';");
    expect(readFileSync('server/config/environment.ts', 'utf8')).toMatch(/dbUrl:\s*getEnv\('DATABASE_URL'/);
  });

  it('server.ts is the composition root: middleware, mounts, static serving, listen', () => {
    // What is left after the move. A route body appearing here again is the monolith growing back.
    expect(server).toContain('app.use(requestId);');
    expect(server).toContain('app.use(securityHeaders());');
    expect(server).toContain('app.use(terminalErrorHandler);');
    expect(server).toContain('app.listen(PORT');
    expect(server).not.toMatch(/orgPath\(orgScope\(req\)/);
    expect(server).not.toContain('sendCaught(');
  });
});

// =============================================================================================
describe('2. the guardrails that read server.ts read the routers too', () => {
  it('check-no-fabricated-success scans every file under server/routes', () => {
    const guard = readFileSync('scripts/check-no-fabricated-success.mjs', 'utf8');
    expect(guard).toMatch(/readdirSync\('server\/routes'\)/);
    expect(guard).toMatch(/\(\?:app\|\[A-Za-z\]\+Router\)/);
  });

  it('THE INVARIANT — the guardrail fails on a fixed answer in a router-shaped file, in both forms, and passes a computed one', () => {
    // Behaviour, not text: a mutant that kept the LITERAL_ANSWER constant and dropped its use
    // survived a text pin on the constant's name. The script is run against a file of its own.
    const dir = mkdtempSync(join(tmpdir(), 'fabricated-'));
    try {
      const run = (code: string) => {
        const file = join(dir, 'probe.routes.ts');
        writeFileSync(file, code);
        const r = spawnSync(process.execPath, ['scripts/check-no-fabricated-success.mjs'], {
          env: { ...process.env, CHECK_FILES: file },
          encoding: 'utf8',
        });
        return { status: r.status, out: `${r.stdout}${r.stderr}` };
      };
      const arrow = run("probeRouter.get('/x', (req: Request, res: Response) => res.json({ decision: \"Proceed\" }));\n");
      expect(arrow.status, arrow.out).not.toBe(0);
      expect(arrow.out).toContain('fixed answer');
      const block = run("probeRouter.post('/x', (req: Request, res: Response) => {\n  res.json({ intentConfidence: 0.9 });\n});\n");
      expect(block.status, block.out).not.toBe(0);
      const success = run("probeRouter.post('/x', (req: Request, res: Response) => res.json({ success: true }));\n");
      expect(success.status, success.out).not.toBe(0);
      const computed = run("probeRouter.get('/x', (req: Request, res: Response) => res.json({ decision: verdictFor(req) }));\n");
      expect(computed.status, computed.out).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the other scanners take the server/ root, which holds the routers', () => {
    for (const f of readdirSync('scripts').filter((n) => n.startsWith('check-') && n.endsWith('.mjs'))) {
      const guard = readFileSync(`scripts/${f}`, 'utf8');
      if (!/['"]server\.ts['"]/.test(guard)) continue;
      const scansServerDir = /(?:ROOTS|SCAN_ROOTS|SCAN_DIRS|FILES)\s*=\s*\[[^\]]*['"]server['"]/.test(guard) || /readdirSync\('server\/routes'\)/.test(guard);
      expect(scansServerDir, `${f} reads server.ts by name but never the server/ tree`).toBe(true);
    }
  });
});

// =============================================================================================
describe('3. the fixed answers refuse, and the echo does too (run-cycle-now runs a campaign tick since S26)', () => {
  const REFUSING = [
    'POST /api/autopilot/settings',
    'POST /api/leads/research',
    'POST /api/leads/:id/simulate-reply',
    'POST /api/inbox/:id/classify',
    'GET /api/inbox/sales-decision-engine/inspect',
    'POST /api/meetings/brief',
    'GET /api/sender-identity',
    'GET /api/linkedin-config',
  ];
  for (const route of REFUSING) {
    it(`${route} answers NOT_IMPLEMENTED and returns no fixed value`, () => {
      const entry = table.find((r) => `${r.method} ${r.path}` === route);
      expect(entry, route).toBeDefined();
      const handler = handlerTextOf(entry!);
      expect(handler).toMatch(/sendError\(\s*req,\s*res,\s*'NOT_IMPLEMENTED'/);
      expect(handler).not.toMatch(/res\.json\(/);
    });
  }

  it('the route table reads a named arrow handler declared above its registration', () => {
    // setCampaignStatus and setOpportunityStage are `const x = async (...) =>` arrows; until
    // 2026-09-12 the reader followed only `function x(`, so their four routes were read as one
    // registration line and reported as reading no body.
    for (const route of ['POST /api/campaigns/:id/status', 'POST /api/campaigns/:id/toggle', 'PUT /api/pipeline/:id/stage', 'POST /api/pipeline/:id/stage']) {
      const entry = table.find((r) => `${r.method} ${r.path}` === route)!;
      expect(entry.readsBody, route).toBe(true);
      expect(handlerTextOf(entry)).toContain('parsedBodyOr400(');
    }
  });
});

// =============================================================================================
describe('4. the rerouted state changes validate before they read, and the map is asked after', () => {
  beforeEach(() => memory.reset());

  type Handler = (req: any, res: any) => Promise<unknown>;
  async function call(handler: Handler, params: Record<string, string>, body: unknown, headers: Record<string, string> = {}) {
    const req = { params, body, headers, method: 'POST', originalUrl: '/probe', tenant: { orgId: 'org-a', source: 'claim', uid: 'u1' } };
    let status = 200;
    let payload: any;
    const res = {
      headersSent: false,
      status(code: number) { status = code; return res; },
      json(value: unknown) { payload = value; return res; },
      setHeader() { return res; },
    };
    await handler(req, res);
    return { status, payload };
  }

  it('THE INVARIANT — an unknown stage on a record that does not exist is a 400, not a 404: the schema runs before the read', async () => {
    const r = await call(setOpportunityStage, { id: 'nope' }, { stage: 'nonsense' });
    expect(r.status).toBe(400);
    expect(r.payload.error.code).toBe('VALIDATION_ERROR');
  });

  it('a known stage on a record that does not exist is a 404', async () => {
    const r = await call(setOpportunityStage, { id: 'nope' }, { stage: 'WON' });
    expect(r.status).toBe(404);
    expect(r.payload.error.code).toBe('NOT_FOUND');
  });

  it('THE INVARIANT — a body carrying more than the status is refused, and nothing is read', async () => {
    let reads = 0;
    memory.beforeTransactionRead = () => { reads++; };
    const r = await call(setCampaignStatus, { id: 'c1' }, { status: 'ACTIVE', enrolledCount: 5000 });
    expect(r.status).toBe(400);
    expect(r.payload.error.message).toMatch(/enrolledCount/);
    expect(reads).toBe(0);
  });

  it('the map is asked after the schema: DRAFT -> PAUSED is a legal state and an illegal move, 422', async () => {
    memory.docs['organizations/org-a/campaigns/c1'] = { id: 'c1', status: 'DRAFT', version: 0 };
    const r = await call(setCampaignStatus, { id: 'c1' }, { status: 'PAUSED' });
    expect(r.status).toBe(422);
    expect(memory.docs['organizations/org-a/campaigns/c1'].status).toBe('DRAFT');
  });

  it('DRAFT -> ACTIVE with the version stated moves the campaign, through both spellings of the route', async () => {
    memory.docs['organizations/org-a/campaigns/c1'] = { id: 'c1', status: 'DRAFT', version: 0 };
    const r = await call(setCampaignStatus, { id: 'c1' }, { status: 'ACTIVE' }, { 'if-match': '"0"' });
    expect(r.status).toBe(200);
    expect(memory.docs['organizations/org-a/campaigns/c1'].status).toBe('ACTIVE');
    expect(routeTable().filter((x) => /\/api\/campaigns\/:id\/(status|toggle)$/.test(x.path)).map((x) => x.line)).toHaveLength(2);
  });
});
