import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { blankComments, inlineRoutes, routeTable, openApiPath, handlerTextOf, type RouteEntry } from '../build/routeTable';
import { REQUEST_CONTRACTS, CONTRACT_EVIDENCE } from '../build/apiSurface';
import {
  buildOpenApiDocument,
  bodyKindOf,
  requestSchemaFor,
  OPENAPI_DOCUMENT_PATH,
  isApiRoute,
} from '../build/openapi';

/**
 * THE API CONTRACT (S11): a document generated from the route table, committed, and held.
 *
 * The row asked for an OpenAPI document and a contract test against one. A document written by
 * hand would be a second copy of the route table, and second copies drift; so the document is
 * GENERATED — paths and methods from what the server registers, request schemas from the zod
 * schemas the handlers parse with — and this suite regenerates it and refuses any difference
 * from the committed copy. It then checks, both ways, that the document and the server agree on
 * which routes exist; that every contract in the document is byte-for-byte what zod emits for the
 * schema the handler uses; that each route the registry claims to validate really does; and it
 * names the routes that read a body no schema describes, so that list can shrink and never grow.
 */

const table = routeTable();
const api = table.filter(isApiRoute);
const committed = JSON.parse(readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8')) as Record<string, any>;
const key = (r: RouteEntry) => `${r.method} ${r.path}`;
const server = readFileSync('server.ts', 'utf8').replace(/\r\n/g, '\n');

// =============================================================================================
describe('1. the route table reads what the server registers', () => {
  it('finds the inline registrations and every mounted router', () => {
    expect(api.length).toBeGreaterThanOrEqual(87);
    for (const wanted of [
      'GET /api/health',
      'POST /api/pipeline',
      'GET /api/spend', // a router mounted with a literal prefix
      'POST /api/csp-report', // a router mounted with an imported constant
      'GET /api/outbox/:id', // a router route with a parameter
      'POST /api/stripe/webhook', // a router whose export is separate from its declaration
      'GET /api/openapi.json', // this document's own route
    ]) {
      expect(api.map(key), wanted).toContain(wanted);
    }
  });

  it('the SPA catch-all is a registration, kept in the table and out of the document', () => {
    expect(table.filter((r) => !isApiRoute(r)).map(key)).toEqual(['GET *']);
  });

  it('refuses a registration it cannot read rather than omitting it', () => {
    expect(() => inlineRoutes('app.post("/api/a", h);\napp.get(dynamicPath, h);', new Set())).toThrow(/cannot read/);
    expect(inlineRoutes('app.post("/api/a", h);', new Set())).toHaveLength(1);
  });

  it('the comment scanner keeps the raw-body content type string and blanks a commented-out route', () => {
    // The string '*/*' opened a block comment in a regex-based stripper and ate the router mounts.
    const code = "app.use('/x', express.raw({ type: '*/*' }));\n// app.get(\"/api/old\", h)\napp.get(\"/api/new\", h); /* app.post(\"/api/dead\", h) */";
    const blanked = blankComments(code);
    expect(blanked).toContain("'*/*'");
    expect(blanked).toContain('app.get("/api/new"');
    expect(blanked).not.toContain('/api/old');
    expect(blanked).not.toContain('/api/dead');
    expect(blanked.length).toBe(code.length);
  });

  it('a helper declared between two routes is not read as part of the earlier one', () => {
    // createContact is declared after GET /api/leads and validates a body; the GET does not.
    const get = api.find((r) => key(r) === 'GET /api/leads')!;
    expect(get.readsBody).toBe(false);
    for (const post of ['POST /api/leads', 'POST /api/investors', 'POST /api/partners']) {
      expect(bodyKindOf(api.find((r) => key(r) === post)!, REQUEST_CONTRACTS)).toBe('contract');
    }
  });

  it('a raw-body route is recognised whether the parser is mounted on the app or on the route', () => {
    expect(api.find((r) => key(r) === 'POST /api/signature/webhook')!.rawBody).toBe(true);
    expect(api.find((r) => key(r) === 'POST /api/stripe/webhook')!.rawBody).toBe(true);
  });

  it('express parameters become OpenAPI parameters, in order', () => {
    expect(openApiPath('/api/outbox/:id/requeue')).toEqual({ path: '/api/outbox/{id}/requeue', params: ['id'] });
    expect(openApiPath('/api/a/:x/b/:y')).toEqual({ path: '/api/a/{x}/b/{y}', params: ['x', 'y'] });
  });
});

// =============================================================================================
describe('2. the committed document is what the table generates, and lists exactly the routes', () => {
  it('THE INVARIANT — regenerating the document yields the committed copy', () => {
    expect(
      buildOpenApiDocument(),
      `docs/production/openapi.json is not what the route table generates. Run: npm run openapi`
    ).toEqual(committed);
  });

  it('every API route is an operation in the document, and every operation is a route', () => {
    const inDocument = new Set<string>();
    for (const [path, ops] of Object.entries(committed.paths as Record<string, Record<string, unknown>>)) {
      for (const method of Object.keys(ops)) inDocument.add(`${method.toUpperCase()} ${path}`);
    }
    const inTable = new Set(api.map((r) => `${r.method} ${openApiPath(r.path).path}`));
    expect([...inTable].filter((k) => !inDocument.has(k))).toEqual([]);
    expect([...inDocument].filter((k) => !inTable.has(k))).toEqual([]);
  });

  it('the coverage figures are a recount of the table, not a claim', () => {
    const kinds = api.map((r) => bodyKindOf(r, REQUEST_CONTRACTS));
    expect(committed['x-coverage']).toEqual({
      routes: api.length,
      withRequestContract: kinds.filter((k) => k === 'contract').length,
      readingBodyWithoutSchema: kinds.filter((k) => k === 'no-schema').length,
      rawBody: kinds.filter((k) => k === 'raw').length,
      responsesDescribed: 0,
      nonApiRoutesOmitted: table.length - api.length,
    });
  });

  it('every operation names its source line and its body kind', () => {
    for (const [path, ops] of Object.entries(committed.paths as Record<string, Record<string, any>>)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(op['x-source'], `${method} ${path}`).toMatch(/^(server\.ts|server\/routes\/[a-zA-Z]+\.routes\.ts):\d+$/);
        expect(['none', 'raw', 'contract', 'no-schema'], `${method} ${path}`).toContain(op['x-body']);
        expect(op.responses.default.content['application/json'].schema.properties.error.properties.code.enum.length).toBeGreaterThan(5);
      }
    }
  });
});

// =============================================================================================
describe('3. each contract in the document is what zod emits for the schema the handler uses', () => {
  for (const [route, schema] of Object.entries(REQUEST_CONTRACTS)) {
    it(`${route}`, () => {
      const [method, expressPath] = route.split(' ');
      const op = committed.paths[openApiPath(expressPath).path][method.toLowerCase()];
      expect(op['x-body']).toBe('contract');
      expect(op.requestBody.required).toBe(true);
      expect(op.requestBody.content['application/json'].schema).toEqual(requestSchemaFor(schema));
      // A contract that accepts anything is not one.
      expect(schema.safeParse(42).success).toBe(false);
      expect(schema.safeParse('not an object').success).toBe(false);
    });
  }

  it('the strict contracts say so: unknown fields are refused, and the document says they are', () => {
    for (const route of ['POST /api/company-brain', 'POST /api/company-brain/generate', 'POST /api/settings']) {
      const [method, expressPath] = route.split(' ');
      const op = committed.paths[openApiPath(expressPath).path][method.toLowerCase()];
      expect(op.requestBody.content['application/json'].schema.additionalProperties, route).toBe(false);
      expect(REQUEST_CONTRACTS[route].safeParse({ unexpectedField: 1 }).success, route).toBe(false);
    }
  });

  it("a schema's constraints reach the document", () => {
    const settings = committed.paths['/api/settings'].post.requestBody.content['application/json'].schema;
    expect(settings.properties.workingHoursStart).toMatchObject({ type: 'integer', minimum: 0, maximum: 23 });
    expect(settings.properties.senderEmail.format).toBe('email');
  });
});

// =============================================================================================
describe('4. a route the registry claims to validate really parses through its schema', () => {
  for (const route of Object.keys(REQUEST_CONTRACTS)) {
    it(`${route}`, () => {
      // S39 — read from the file the route table says holds the registration.
      const entry = table.find((r) => `${r.method} ${r.path}` === route);
      expect(entry, `${route} is not registered`).toBeDefined();
      const handler = handlerTextOf(entry!);
      expect(handler, `${route}: no evidence of the schema in the handler`).toMatch(CONTRACT_EVIDENCE[route]);
    });
  }

  it('the three contact routes share one validating helper, and it is the one the evidence names', () => {
    const contacts = readFileSync('server/routes/contacts.routes.ts', 'utf8');
    expect(contacts).toMatch(/async function createContact\([\s\S]{0,400}parseOrRespond\(createContactSchema, req, res\)/);
  });
});

// =============================================================================================
describe('5. the routes that read a body no schema describes are exactly these', () => {
  /**
   * Named, not counted. A count can stay the same while one route gains a schema and another
   * loses one. This list may only SHRINK: a route that gains a contract is removed from here and
   * added to server/build/apiSurface.ts; a route that appears here for the first time is a new
   * body reader with no schema, and the fix is a schema, not a longer list. Some of these check
   * fields by hand (`requeueReasonFrom`, `reportsFrom`, a typeof on `enabled`); the document
   * cannot describe a hand check, which is what "no schema" means here.
   */
  const RECORDED = [
    'POST /api/autonomy/:conversationId',
    'POST /api/campaigns/generate-strategy',
    'POST /api/contacts/:survivorId/merge',
    'POST /api/csp-report',
    'POST /api/growth-command',
    'POST /api/inbox/circuit-breaker/toggle',
    'POST /api/inbox/validate-phone-policy',
    'POST /api/integrations/gmail/token',
    'POST /api/meetings',
    'POST /api/outbox/:id/reject',
    'POST /api/outbox/:id/requeue',
    'POST /api/pitch-battle/simulate',
    'POST /api/stripe/create-checkout-session',
    'POST /api/webhooks/gmail',
  ];

  it('THE INVARIANT — no body reader without a schema has appeared that is not already named', () => {
    const actual = api.filter((r) => bodyKindOf(r, REQUEST_CONTRACTS) === 'no-schema').map(key).sort();
    const recorded = new Set(RECORDED);
    expect(
      actual.filter((k) => !recorded.has(k)),
      'a route reads req.body and no schema describes it; give it a contract in server/build/apiSurface.ts'
    ).toEqual([]);
  });

  it('and the list is current: every name on it is still such a route', () => {
    const actual = new Set(api.filter((r) => bodyKindOf(r, REQUEST_CONTRACTS) === 'no-schema').map(key));
    expect(RECORDED.filter((k) => !actual.has(k)), 'a route gained a schema — remove it from the list').toEqual([]);
  });
});

// =============================================================================================
describe('6. the server serves the committed document, and says so when it cannot', () => {
  const route = readFileSync('server/routes/openapi.routes.ts', 'utf8');
  it('reads the committed file rather than regenerating', () => {
    expect(route).toContain('readFileSync(OPENAPI_DOCUMENT_PATH');
    expect(route).not.toContain('buildOpenApiDocument');
  });
  it('a deployment without the file gets a 503 in the envelope, not an empty document', () => {
    expect(route).toMatch(/sendError\([\s\S]*'CONFIGURATION_ERROR'[\s\S]*status: 503/);
  });
  it('is mounted at /api/openapi.json', () => {
    expect(server).toContain('app.use("/api/openapi.json", openapiRouter);');
  });
});
