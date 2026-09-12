import { readFileSync } from 'node:fs';
import { z, type ZodType } from 'zod';
import { routeTable, openApiPath, type RouteEntry } from './routeTable';
import { REQUEST_CONTRACTS } from './apiSurface';
import { ErrorCodes } from '../lib/errors';

/**
 * S11 — the OpenAPI document, generated from the route table and the contract registry.
 *
 * Nothing in it is typed by hand. Paths and methods come from what server.ts and the routers
 * register (server/build/routeTable.ts); request-body schemas come from the zod schemas the
 * handlers actually parse with (server/build/apiSurface.ts), emitted as JSON Schema by zod
 * itself; the error response is the one envelope every error goes through (server/lib/errors.ts,
 * held by check-error-envelope). The document says what it does NOT describe — success bodies,
 * and the routes that read a body no schema governs — in `x-coverage` and per-operation
 * `x-body`, because a document that lists only its good parts is a brochure.
 *
 * The committed copy at docs/production/openapi.json must equal what this generates; the suite
 * regenerates and compares, so the document cannot drift from the code it describes.
 */

export type BodyKind = 'none' | 'raw' | 'contract' | 'no-schema';

export function bodyKindOf(route: RouteEntry, contracts: Readonly<Record<string, ZodType>>): BodyKind {
  if (contracts[`${route.method} ${route.path}`]) return 'contract';
  if (route.rawBody) return 'raw';
  return route.readsBody ? 'no-schema' : 'none';
}

/** The envelope server/lib/errors.ts builds. Codes are the taxonomy, not free text. */
export const ERROR_ENVELOPE = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'requestId'],
      properties: {
        code: { type: 'string', enum: Object.keys(ErrorCodes).sort() },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: { type: 'object' },
      },
    },
  },
} as const;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

export function requestSchemaFor(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  const { $schema: _omit, ...rest } = json;
  return rest;
}

export interface OpenApiCoverage {
  routes: number;
  withRequestContract: number;
  readingBodyWithoutSchema: number;
  rawBody: number;
  responsesDescribed: number;
  /** Registrations that are not API operations (the SPA catch-all), counted so their absence is stated. */
  nonApiRoutesOmitted: number;
}

export const isApiRoute = (route: RouteEntry): boolean => route.path.startsWith('/api/');

export function buildOpenApiDocument(
  allRoutes: RouteEntry[] = routeTable(),
  contracts: Readonly<Record<string, ZodType>> = REQUEST_CONTRACTS
): Record<string, unknown> {
  const routes = allRoutes.filter(isApiRoute);
  const paths: Record<string, Record<string, unknown>> = {};
  const coverage: OpenApiCoverage = {
    routes: routes.length,
    withRequestContract: 0,
    readingBodyWithoutSchema: 0,
    rawBody: 0,
    responsesDescribed: 0,
    nonApiRoutesOmitted: allRoutes.length - routes.length,
  };

  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const { path, params } = openApiPath(route.path);
    const kind = bodyKindOf(route, contracts);
    const operation: Record<string, unknown> = {
      operationId: key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
      'x-source': `${route.source}:${route.line}`,
      'x-body': kind,
      responses: {
        default: {
          description: 'Any error, in the envelope server/lib/errors.ts builds; the code is one of the taxonomy.',
          content: { 'application/json': { schema: ERROR_ENVELOPE } },
        },
      },
    };
    if (params.length > 0) {
      operation.parameters = params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } }));
    }
    if (kind === 'contract') {
      operation.requestBody = { required: true, content: { 'application/json': { schema: requestSchemaFor(contracts[key]) } } };
      coverage.withRequestContract++;
    } else if (kind === 'no-schema') {
      operation['x-body-note'] =
        'The handler reads req.body and no schema describes it, so this document cannot either; some of ' +
        'these check fields by hand. Listed by name in openapi.invariant.test.ts; the list may shrink and not grow.';
      coverage.readingBodyWithoutSchema++;
    } else if (kind === 'raw') {
      operation.requestBody = { required: true, content: { '*/*': { schema: { type: 'string', format: 'binary' } } } };
      operation['x-body-note'] = 'Raw bytes: the handler verifies a provider signature over the exact body before reading it.';
      coverage.rawBody++;
    }
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }

  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: string };
  return sortKeys({
    openapi: '3.1.0',
    info: {
      title: 'Abedin Growth AI API',
      version: pkg.version ?? '0.0.0',
      description:
        'Generated from the route table (server/build/routeTable.ts) and the request-contract registry ' +
        '(server/build/apiSurface.ts) by scripts/generate-openapi.ts. Request bodies are the zod schemas ' +
        'the handlers parse with, emitted by zod. Success response bodies are not yet described; ' +
        'x-coverage says how much of the surface each part of this document covers.',
    },
    'x-coverage': coverage,
    paths,
  }) as Record<string, unknown>;
}

export const OPENAPI_DOCUMENT_PATH = 'docs/production/openapi.json';

export function renderOpenApiDocument(document: Record<string, unknown> = buildOpenApiDocument()): string {
  return JSON.stringify(document, null, 2) + '\n';
}
