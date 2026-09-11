#!/usr/bin/env node
/**
 * Fail if the built client is React's DEVELOPMENT build.
 *
 * WHY THIS IS A CHECK ON THE ARTIFACT AND NOT ON THE CONFIG
 * ---------------------------------------------------------
 * `scripts/build-client.mjs` forces NODE_ENV=production, and a check that read that file would
 * only confirm the fix is still written down. What ships is the bundle. The same reasoning already
 * applies in CI to the Gmail scopes: "the source can look clean while the built artifact is not,
 * which is exactly how the second gmail.send grant survived the first fix".
 *
 * A development bundle is 35% larger, carries React's dev-only warning paths, and reports
 * `import.meta.env.DEV === true` to any code that asks — so a branch meant for development runs in
 * production.
 *
 * Usage: node scripts/check-client-bundle-mode.mjs [assets-dir]     (default: dist/assets)
 *
 * Exit 1 on a development marker, on a missing directory, or on a bundle too small to be this
 * application — because "no markers found" in an empty directory is not a clean build.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIR = process.argv[2] ?? join('dist', 'assets');

/**
 * Markers that appear only in a development build. Both were measured against the two builds of
 * this application rather than assumed: `jsxDEV` 4,446 occurrences in the development bundle and 0
 * in the production one; `react.development` 1 and 0.
 */
const DEV_MARKERS = [
  { needle: 'jsxDEV', why: "React's development JSX runtime" },
  { needle: 'react.development', why: "React's development entry point" },
];

/** The rule, as a function, so the self-check below runs it rather than a copy of it. */
function devMarkersIn(source) {
  return DEV_MARKERS.filter((marker) => source.includes(marker.needle));
}

// SELF-CHECK. Run against sources whose answer is known, so a change that blinds the rule fails
// here rather than reporting every bundle clean.
//
// NOTE, recorded rather than hidden: disabling this self-check is a mutant that SURVIVES the gate
// (measured 2026-09-12), and it is unexpressible against this tree. A self-check is insurance — it
// fires only when the rule itself is broken, so with the rule intact removing it changes no
// outcome. Its insured events were run as their own mutants: dropping the `jsxDEV` marker, and
// letting a missing bundle pass. Both are KILLED.
const SELF_CHECK = [
  ['const a = jsxDEV("div", {}, void 0, false);', 1],
  ['import "./react.development.js";', 1],
  ['const a = jsx("div", {});', 0],
  ['const DEV = false;', 0],
];
for (const [source, expected] of SELF_CHECK) {
  const found = devMarkersIn(source).length;
  if (found !== expected) {
    console.error(
      `check-client-bundle-mode SELF-CHECK FAILED: ${JSON.stringify(source)} gave ${found} ` +
        `marker(s), expected ${expected}. The rule is broken, not the bundle clean.`
    );
    process.exit(1);
  }
}

if (!existsSync(DIR)) {
  console.error(
    `check-client-bundle-mode: ${DIR} does not exist. Build the client first — a missing bundle ` +
      'is not a clean one.'
  );
  process.exit(1);
}

const files = readdirSync(DIR).filter((name) => name.endsWith('.js'));
if (files.length === 0) {
  console.error(
    `check-client-bundle-mode: no .js files in ${DIR}. The check is broken, not the bundle clean.`
  );
  process.exit(1);
}

let bytes = 0;
const offenders = [];
for (const name of files) {
  const path = join(DIR, name);
  bytes += statSync(path).size;
  for (const marker of devMarkersIn(readFileSync(path, 'utf8'))) {
    offenders.push({ path, ...marker });
  }
}

const MIN_BYTES = 50_000;
if (bytes < MIN_BYTES) {
  console.error(
    `check-client-bundle-mode: ${DIR} holds ${bytes} bytes of JavaScript, below the ${MIN_BYTES} ` +
      'floor. That is too small to be this application, so the scan looked at the wrong place.'
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('check-client-bundle-mode: the client bundle is a DEVELOPMENT build.\n');
  for (const offender of offenders) {
    console.error(`  ${offender.path} contains ${offender.needle} — ${offender.why}`);
  }
  console.error(
    '\nBuild with `npm run build`, which forces NODE_ENV=production. `vite build` alone reads\n' +
      'NODE_ENV from .env, where it is `development`.'
  );
  process.exit(1);
}

console.log(
  `check-client-bundle-mode: ok — ${files.length} file(s), ${bytes} bytes, no development markers.`
);
