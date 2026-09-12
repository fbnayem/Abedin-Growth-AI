import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument, renderOpenApiDocument, OPENAPI_DOCUMENT_PATH } from '../server/build/openapi';

/**
 * S11 — write docs/production/openapi.json from the route table and the contract registry.
 *
 * Run after changing a route or a request schema: `npm run openapi`. The suite regenerates the
 * document and compares it to the committed copy, so forgetting to run this fails the gate
 * rather than shipping a document that describes the previous server.
 */
const document = buildOpenApiDocument();
writeFileSync(OPENAPI_DOCUMENT_PATH, renderOpenApiDocument(document));
const coverage = document['x-coverage'] as Record<string, number>;
console.log(
  `${OPENAPI_DOCUMENT_PATH}: ${coverage.routes} routes; ${coverage.withRequestContract} with a request contract, ` +
    `${coverage.readingBodyWithoutSchema} reading a body no schema describes, ${coverage.rawBody} raw; ` +
    `${coverage.responsesDescribed} success responses described.`
);
