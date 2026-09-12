import { writeFileSync } from 'node:fs';
import { buildCodeGraph, renderCodeGraph, CODE_GRAPH_PATH } from '../server/build/codeGraph';

/**
 * S1 — write docs/production/active-code-graph.md from the tree.
 *
 * Run after adding, deleting or rewiring a module: `npm run code-graph`. The suite regenerates
 * the graph and compares it to the committed copy, so a stale graph fails the gate instead of
 * describing a tree that no longer exists.
 */
const graph = buildCodeGraph();
writeFileSync(CODE_GRAPH_PATH, renderCodeGraph(graph));
console.log(
  `${CODE_GRAPH_PATH}: ${graph.reachableFrom.size} live modules, ${graph.operationalOnly.size} operational-only, ` +
    `${graph.dead.length} dead file(s)${graph.dead.length ? ': ' + graph.dead.join(', ') : ''}`
);
