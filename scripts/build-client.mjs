#!/usr/bin/env node
/**
 * Build the client in PRODUCTION mode, whatever `.env` says.
 *
 * WHY THIS EXISTS
 * ---------------
 * `.env` carries `NODE_ENV=development`, and `.env.example` ships that line, so every developer
 * copy has it. Vite reads NODE_ENV from `.env` unless `process.env.NODE_ENV` is already set — so
 * `vite build` produced a DEVELOPMENT client bundle on any machine with a `.env`.
 *
 * Measured 2026-09-12, the same commit, the same config:
 *
 *     vite build                       1,996,561 bytes   import.meta.env.DEV === true
 *     NODE_ENV=production vite build   1,302,215 bytes   import.meta.env.DEV === false
 *
 * The larger artifact is React's development runtime: 4,446 occurrences of `jsxDEV`, its
 * dev-only warnings, and its slower paths. CI has no `.env`, so CI's artifact was correct and
 * nothing in the pipeline could have noticed. That a developer's build and CI's build differed
 * at all is the defect; which one was wrong is secondary.
 *
 * Setting NODE_ENV BEFORE importing vite is what fixes it: vite treats an already-set NODE_ENV as
 * authoritative and does not override it from `.env`. `mode` is passed as well, so `.env.production`
 * is the environment file loaded and `import.meta.env.MODE` agrees with the rest.
 */

process.env.NODE_ENV = 'production';

const { build } = await import('vite');

console.log('[build-client] NODE_ENV=production (forced; .env cannot lower it)');

await build({ mode: 'production' });
