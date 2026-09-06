#!/usr/bin/env node
/**
 * P1.1 — Grant a user membership of an organisation.
 *
 *   node scripts/set-org-claim.mjs --email someone@example.com --org acme
 *   node scripts/set-org-claim.mjs --uid abc123 --org acme,globex
 *   node scripts/set-org-claim.mjs --email someone@example.com --revoke
 *
 * WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
 * ----------------------------------------
 * Membership is the grant, and the grant must not be writable by the thing it authorises.
 * A custom claim can only be set with Admin SDK credentials, which the running server does
 * not use for this purpose — so no request to the API, however privileged it looks, can widen
 * anyone's tenancy. That is what makes the claim trustworthy enough to resolve tenants from.
 *
 * The claim is written as BOTH `orgId` (single) and `orgIds` (array) shapes depending on how
 * many organisations are given, matching what server/middleware/tenant.ts reads.
 *
 * CREDENTIALS
 * -----------
 * Uses application default credentials. Point GOOGLE_APPLICATION_CREDENTIALS at a service
 * account key with the Firebase Authentication Admin role, or run under an environment that
 * already has them (e.g. `gcloud auth application-default login`). The script does not read,
 * store or print credentials.
 *
 * Claims take effect on the user's NEXT token, not immediately. Existing ID tokens keep their
 * old claims until they expire (an hour at most) or the client forces a refresh. That matters
 * most for revocation: use it together with the membership document, which takes effect at
 * once because the server reads it per request.
 */

import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ORG_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'revoke' || key === 'help') {
      args[key] = true;
      continue;
    }
    args[key] = argv[++i];
  }
  return args;
}

function usage(message) {
  if (message) console.error(`\nError: ${message}\n`);
  console.error(
    `Usage:
  node scripts/set-org-claim.mjs --email <email> --org <orgId>[,<orgId>...]
  node scripts/set-org-claim.mjs --uid <uid>     --org <orgId>[,<orgId>...]
  node scripts/set-org-claim.mjs --email <email> --revoke

Options:
  --email    Look the user up by email address.
  --uid      Look the user up by Firebase uid.
  --org      One or more organisation ids, comma separated.
  --revoke   Remove all organisation membership from this user.
  --project  Firebase project id (defaults to firebase-applet-config.json, then
             GOOGLE_CLOUD_PROJECT).
`
  );
  process.exit(message ? 1 : 0);
}

function resolveProjectId(explicit) {
  if (explicit) return explicit;
  const configPath = resolve(process.cwd(), 'firebase-applet-config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.projectId) return config.projectId;
    } catch {
      // Fall through to the environment.
    }
  }
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) usage();

if (!args.email && !args.uid) usage('Give either --email or --uid.');
if (args.email && args.uid) usage('Give --email or --uid, not both.');
if (!args.org && !args.revoke) usage('Give --org, or --revoke to remove membership.');

let orgIds = [];
if (!args.revoke) {
  orgIds = String(args.org)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (orgIds.length === 0) usage('--org listed no organisations.');
  const invalid = orgIds.filter((id) => !ORG_ID_PATTERN.test(id));
  if (invalid.length > 0) {
    usage(
      `Not valid organisation ids: ${JSON.stringify(invalid)}. ` +
        `Expected 1-64 characters of letters, digits, hyphen or underscore.`
    );
  }
}

const projectId = resolveProjectId(args.project);
if (!projectId) usage('Could not determine the Firebase project id; pass --project.');

if (getApps().length === 0) {
  initializeApp({ credential: applicationDefault(), projectId });
}
const auth = getAuth();

const user = args.uid
  ? await auth.getUser(args.uid)
  : await auth.getUserByEmail(args.email);

// Preserve any claims that are not ours. Overwriting the whole claim object would silently
// drop unrelated authorisation another part of the system depends on.
const existing = user.customClaims || {};
const { orgId: _droppedOrgId, orgIds: _droppedOrgIds, ...preserved } = existing;

let claims;
if (args.revoke) {
  claims = { ...preserved };
} else if (orgIds.length === 1) {
  claims = { ...preserved, orgId: orgIds[0] };
} else {
  claims = { ...preserved, orgIds };
}

await auth.setCustomUserClaims(user.uid, claims);

const before = existing.orgId ? [existing.orgId] : existing.orgIds || [];
console.log(`User:   ${user.uid}${user.email ? ` (${user.email})` : ''}`);
console.log(`Before: ${before.length ? before.join(', ') : '(no organisation)'}`);
console.log(`After:  ${orgIds.length ? orgIds.join(', ') : '(no organisation)'}`);
console.log(
  '\nThe change applies to the user\'s NEXT ID token. Tokens already issued keep their old ' +
    'claims for up to an hour. To cut access off immediately, also write a members document ' +
    'with status other than ACTIVE at organizations/<orgId>/members/<uid> — the server reads ' +
    'that on every request.'
);
