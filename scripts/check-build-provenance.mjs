#!/usr/bin/env node
/**
 * Assert that a build can say which commit it is.
 *
 * WHY THIS IS NOT A UNIT TEST
 * ---------------------------
 * The unit tests for `resolveProvenance` cover the resolution: injected wins, a working tree is
 * labelled as one, nothing is `UNKNOWN`. All of that passes whether or not CI ever sets
 * `BUILD_SHA` — which is three lines of YAML, easily lost in a merge, and its absence looks
 * exactly like success everywhere else. This runs after the build, in the environment the build
 * ran in, and fails when the identity is not there.
 *
 * S49's worst case is an operator reaching for the kill switch while nobody can say which build
 * is running or what to roll back to. `/api/health` used to answer
 * `{ status: "ok", service: "Abedin Growth AI Core Engine" }` — the same string in every build
 * that has ever run.
 *
 * It also checks the shipped bundle, because provenance that exists only in the source tree
 * answers nothing about the artifact that was deployed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolveProvenance } from '../server/build/provenance.ts';

const problems = [];

const provenance = resolveProvenance();

if (provenance.source !== 'INJECTED') {
  problems.push(
    `build identity is ${provenance.source}, not INJECTED. Set BUILD_SHA in the build step. ` +
      'A SHA read from a working tree names a commit that may differ from what is running, ' +
      'which is why it is not accepted here.'
  );
}

if (!provenance.sha || !/^[0-9a-f]{7,40}$/i.test(provenance.sha)) {
  problems.push(`BUILD_SHA is ${JSON.stringify(provenance.sha)}, which is not a commit id`);
}

if (provenance.identifiesAReleasedArtifact !== true) {
  problems.push('the build does not claim to identify a released artifact');
}

if (!provenance.expectsMigration) {
  problems.push(
    'the build cannot say which migration it expects. Without it, "the code is ahead of the ' +
      'schema" and "the schema is ahead of the code" are the same incident with different fixes.'
  );
}

// The bundle, not the source tree. `resolveProvenance` reading correctly here says nothing
// about whether the file that gets deployed contains it.
const BUNDLE = 'dist/server.cjs';
if (!existsSync(BUNDLE)) {
  problems.push(`${BUNDLE} does not exist — run the build before this check`);
} else {
  const bundle = readFileSync(BUNDLE, 'utf8');
  if (!bundle.includes('BUILD_SHA')) {
    problems.push(
      `${BUNDLE} never reads BUILD_SHA, so the deployed artifact cannot report its identity ` +
        'however the build environment was configured'
    );
  }
  if (!bundle.includes('GIT_WORKING_TREE')) {
    problems.push(
      `${BUNDLE} does not carry the provenance source labels, so it cannot distinguish an ` +
        'injected identity from one guessed off a working tree'
    );
  }
}

if (problems.length > 0) {
  console.error('check-build-provenance: this artifact cannot say which commit it is —');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(
  `check-build-provenance: ok — ${provenance.sha.slice(0, 12)} (${provenance.source}), ` +
    `expects migration ${provenance.expectsMigration}.`
);
