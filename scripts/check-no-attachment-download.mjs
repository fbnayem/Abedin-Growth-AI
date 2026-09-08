#!/usr/bin/env node
/**
 * S17 — fail if this application starts downloading, storing or modelling attachment CONTENT.
 *
 * WHY THIS EXISTS
 * ---------------
 * The status document's remainder for S17 was "attachment allowlist / content sniffing /
 * storage / retention". Three of those four are answered by a posture rather than by a feature:
 * this system reads attachment METADATA out of the MIME structure — filename, declared type,
 * size, the provider's attachment id — and never fetches the bytes.
 *
 * So there is nothing to sniff, nothing at rest, and no retention period to set. That is the
 * safest available answer, and it is worth more than a scanner would be: sniffing requires
 * downloading first, which means this application would hold prospect-supplied binaries, and
 * holding them is what creates the need for the scanner.
 *
 * But it is currently true by ABSENCE, and §1 of the addendum rejects absence as a control:
 * "nothing broke yet" is not a control. One line added by somebody who wanted attachment
 * preview flips the posture with nothing to notice it — which is the same argument
 * `check-no-html-sink.mjs` makes about `dangerouslySetInnerHTML`, and it was right there.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a claim that attachments are safe. It is the boundary that makes the claim in
 * `server/domain/attachmentPolicy.ts` true: that policy decides from metadata, because metadata
 * is all this system has.
 *
 * If downloading attachments is ever genuinely needed, the change lands a scanner, a storage
 * location with a retention policy, and an amendment to this file — deliberately, in one commit,
 * with the argument written down. That is the point of failing here rather than reviewing it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SCAN_ROOTS = ['server', 'src', 'shared'];
const SCAN_FILES = ['server.ts'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'tests']);

const RULES = [
  {
    id: 'ATTACHMENT_FETCH',
    // Gmail's endpoint is `users/{userId}/messages/{messageId}/attachments/{id}`. Matched on
    // the path shape rather than on a method name, because the call is a `fetch` of a URL and
    // there is no method to name.
    pattern: /messages\/[^'"`\s]*\/attachments|attachments\.get\s*\(|getAttachment\s*\(/g,
    message:
      "a fetch of attachment CONTENT. This system reads attachment metadata only; downloading " +
      'the bytes means holding prospect-supplied binaries, which is what creates the need for ' +
      'a scanner and a retention policy. See server/domain/attachmentPolicy.ts.',
  },
  {
    id: 'ATTACHMENT_AT_REST',
    // Writing the decoded body of an attachment anywhere. `attachmentId` is a handle and is
    // fine to store; `attachmentData`/`attachmentBytes`/`attachmentBuffer` are the content.
    pattern: /\battachment(Data|Bytes|Buffer|Content|Blob|File)\b/gi,
    message:
      'attachment content held in a variable or column. Nothing in this system stores ' +
      'attachment bytes, and a name that says it does is either a new capability or a lie ' +
      'about an existing one. Both need the argument written down.',
  },
];

/** Comments may name these things — that is how the reasons above get recorded. */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') i++;
      i += 2;
      continue;
    }
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      // Strings are KEPT, unlike in some of the other guardrails: a URL path is a string, and
      // stripping them would make ATTACHMENT_FETCH match nothing at all. The self-check below
      // is what proves that decision did not silently disable the rule.
      out += ch;
      i++;
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') {
          out += source[i];
          i++;
        }
        if (i < n) {
          out += source[i];
          i++;
        }
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let info;
    try {
      info = statSync(full);
    } catch {
      continue;
    }
    if (info.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.some((e) => entry.endsWith(e))) {
      yield full;
    }
  }
}

const failures = [];
let scanned = 0;

const files = [...SCAN_ROOTS.flatMap((root) => [...walk(root)]), ...SCAN_FILES];
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  scanned++;
  const code = stripCommentsAndStrings(source);
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(code)) !== null) {
      const line = code.slice(0, match.index).split('\n').length;
      failures.push(`${relative('.', file)}:${line} — ${rule.id}: ${rule.message}`);
    }
  }
}

/**
 * A MINIMUM-FILES FLOOR.
 *
 * A guardrail that scans nothing passes silently and forever. If the walk breaks — a renamed
 * directory, a changed extension list — this says so rather than reporting a clean tree.
 */
const MIN_FILES = 100;
if (scanned < MIN_FILES) {
  console.error(
    `check-no-attachment-download: only ${scanned} files scanned (floor ${MIN_FILES}). ` +
      'The scan is broken, not the tree clean.'
  );
  process.exit(1);
}

/**
 * A SELF-CHECK THAT CALLS THE REAL RULES.
 *
 * The rules keep string literals rather than stripping them, which is unusual here and is
 * load-bearing: a URL path IS a string, so stripping would make ATTACHMENT_FETCH match nothing
 * and this guardrail would pass on a tree that downloads every attachment. This runs the real
 * patterns over samples of the defect.
 */
const SAMPLES = [
  `const r = await fetch(\`https://gmail.googleapis.com/gmail/v1/users/me/messages/\${id}/attachments/\${aid}\`);`,
  'const data = await gmail.users.messages.attachments.get({ id });',
  'const attachmentBytes = Buffer.from(part.body.data, "base64");',
  'await db.insert(files).values({ attachmentData: decoded });',
];
for (const sample of SAMPLES) {
  const code = stripCommentsAndStrings(sample);
  const caught = RULES.some((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(code);
  });
  if (!caught) {
    console.error(`check-no-attachment-download: SELF-CHECK FAILED — not detected: ${sample}`);
    process.exit(1);
  }
}
// And the inverse: the metadata this system legitimately records must NOT trip it, or the
// guardrail fails on the code it is meant to protect and gets deleted.
const ALLOWED = [
  'attachmentId: typeof part?.body?.attachmentId === "string" ? part.body.attachmentId : null,',
  'out.attachmentCount++;',
  'const findings = attachmentVerdict(email.parsed.attachments, email.parsed.attachmentCount);',
];
for (const sample of ALLOWED) {
  const code = stripCommentsAndStrings(sample);
  const tripped = RULES.find((rule) => {
    rule.pattern.lastIndex = 0;
    return rule.pattern.test(code);
  });
  if (tripped) {
    console.error(
      `check-no-attachment-download: SELF-CHECK FAILED — ${tripped.id} flagged legitimate ` +
        `metadata handling: ${sample}`
    );
    process.exit(1);
  }
}

if (failures.length > 0) {
  console.error('check-no-attachment-download: FAILED\n');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\nThis system reads attachment metadata and never the bytes, which is what makes ' +
      '"no sniffing, no storage, no retention" a posture rather than a gap. Changing that ' +
      'needs a scanner, a storage location with a retention policy, and an amendment to this ' +
      'file — in one commit, with the argument written down.'
  );
  process.exit(1);
}

console.log(
  `check-no-attachment-download: ok (${scanned} files, ${RULES.length} rules; metadata is ` +
    'read, content is not fetched or stored).'
);
