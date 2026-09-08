import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachmentVerdict,
  attachmentsPermitAutonomy,
  displayName,
  extensionOf,
  allExtensionsOf,
  ATTACHMENT_DISPOSITIONS,
  EXECUTABLE_EXTENSIONS,
  MACRO_EXTENSIONS,
} from '../domain/attachmentPolicy';
import type { AttachmentRecord } from '../lib/mime';

/**
 * INVARIANTS FOR THE ATTACHMENT POLICY (addendum S17).
 *
 * S17's remainder was "allowlist / content sniffing / storage / retention". Three of those are
 * answered by a posture — this system reads attachment METADATA and never fetches the bytes —
 * and the fourth is this module.
 *
 * The posture is the part that needed making into a control rather than a coincidence:
 * `scripts/check-no-attachment-download.mjs` fails if anything starts downloading or storing
 * attachment content, which is the same argument `check-no-html-sink.mjs` makes and it was
 * right there.
 */

const attachment = (over: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
  filename: 'quote.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  attachmentId: 'a1',
  ...over,
});

const RTLO = '\u202E';

describe('1. ordinary business mail is not held', () => {
  /**
   * FIRST, because a policy that holds everything satisfies every safety assertion below and
   * stops the product. A limit that fires on ordinary correspondence gets raised until it does
   * nothing, which is how the original `SAFE_MODE` snapshot came to be ignored.
   */
  it('a normal attachment is CLEAR', () => {
    for (const record of [
      attachment(),
      attachment({ filename: 'Proposal v2.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      attachment({ filename: 'logo.png', mimeType: 'image/png' }),
      attachment({ filename: 'data.csv', mimeType: 'text/csv' }),
      attachment({ filename: 'notes', mimeType: 'application/octet-stream' }),
      attachment({ filename: null, mimeType: 'application/pdf' }),
      attachment({ filename: 'Q3 report (final).pdf' }),
      attachment({ filename: 'contract.zip', mimeType: 'application/zip' }),
    ]) {
      const verdict = attachmentVerdict([record], 1);
      expect(verdict.disposition, `held ${record.filename}`).toBe('CLEAR');
      expect(verdict.reason).toBeNull();
    }
  });

  it('no attachments at all is CLEAR', () => {
    expect(attachmentVerdict([], 0).disposition).toBe('CLEAR');
  });

  it('an unknown extension with an unknown type is not a finding', () => {
    // The type map exists to catch DISAGREEMENTS, not to decide what is allowed. Treating
    // "not in the map" as suspicious would hold every unusual but legitimate format.
    expect(attachmentVerdict([attachment({ filename: 'plan.dwg', mimeType: 'image/vnd.dwg' })], 1).disposition).toBe('CLEAR');
  });
});

describe('2. what stops an autonomous reply', () => {
  const held = (record: Partial<AttachmentRecord>, code: string) => {
    const verdict = attachmentVerdict([attachment(record)], 1);
    expect(verdict.disposition, `not held: ${JSON.stringify(record)}`).toBe('HUMAN_REVIEW');
    expect(verdict.findings.map((f) => f.code)).toContain(code);
  };

  it('an executable', () => {
    held({ filename: 'setup.exe', mimeType: 'application/x-msdownload' }, 'EXECUTABLE');
    held({ filename: 'run.bat', mimeType: 'text/plain' }, 'EXECUTABLE');
    held({ filename: 'tool.jar', mimeType: 'application/java-archive' }, 'EXECUTABLE');
  });

  it('a double extension, on EVERY extension rather than the last', () => {
    // The oldest trick there is, and it works because the reader stops at the first one.
    held({ filename: 'invoice.pdf.exe', mimeType: 'application/pdf' }, 'EXECUTABLE');
    expect(allExtensionsOf('invoice.pdf.exe')).toEqual(['pdf', 'exe']);
  });

  it('a trailing dot or space, which Windows removes on open', () => {
    // `payload.exe.` and `payload.exe ` both execute. A naive `split('.').pop()` reads the
    // extension as `exe.` and `exe `, neither of which is in any list.
    held({ filename: 'payload.exe.' }, 'EXECUTABLE');
    held({ filename: 'payload.exe ' }, 'EXECUTABLE');
    expect(extensionOf('payload.exe.')).toBe('exe');
    expect(extensionOf('payload.exe   ')).toBe('exe');
  });

  /**
   * WHY THE TRAILING-CHARACTER STRIP IS NOT REDUNDANT.
   *
   * Removing it from `allExtensionsOf` survived the first mutation round, and the obvious
   * reading — that each part is already `.trim()`ed and empty parts filtered, so the strip does
   * nothing — is true for spaces and dots and false in general.
   *
   * Measured: over thirteen names the two versions differ on exactly one, `payload.exe\u0000`.
   * `.trim()` strips whitespace, and NUL is not whitespace, so without the strip the extension
   * reads as `exe\u0000` and matches nothing in the executable list.
   *
   * The DISPOSITION is the same either way, because the control character trips its own rule.
   * The FINDINGS are not, and that is what an operator acts on: "odd characters in a filename"
   * reads as a formatting curiosity, and "this is an executable" does not.
   */
  it('a control character cannot hide an executable extension', () => {
    const verdict = attachmentVerdict(
      [attachment({ filename: 'payload.exe\u0000', mimeType: 'application/octet-stream' })],
      1
    );
    const codes = verdict.findings.map((f) => f.code);
    expect(codes).toContain('CONTROL_CHARACTERS');
    expect(codes, 'the executable extension was hidden by the trailing NUL').toContain(
      'EXECUTABLE'
    );
    expect(allExtensionsOf('payload.exe\u0000')).toContain('exe');
  });

  it('a macro-enabled document', () => {
    held({ filename: 'budget.xlsm', mimeType: 'application/vnd.ms-excel.sheet.macroEnabled.12' }, 'MACRO_ENABLED');
  });

  it('a name that disagrees with its declared type', () => {
    held({ filename: 'invoice.pdf', mimeType: 'application/x-msdownload' }, 'TYPE_MISMATCH');
  });

  it('a direction override in the name', () => {
    // `invoice<RTLO>fdp.exe` renders as `invoiceexe.pdf`. A person looking straight at it reads
    // a PDF.
    held({ filename: `invoice${RTLO}fdp.exe` }, 'BIDI_OVERRIDE');
    held({ filename: `report${RTLO}cod.scr` }, 'BIDI_OVERRIDE');
  });

  it('control characters in the name', () => {
    held({ filename: 'quote\n.pdf' }, 'CONTROL_CHARACTERS');
    held({ filename: 'quote\u0000.pdf' }, 'CONTROL_CHARACTERS');
  });

  it('a path in the name', () => {
    held({ filename: '../../etc/passwd' }, 'PATH_IN_NAME');
    held({ filename: 'C:\\windows\\system32\\x.dll' }, 'PATH_IN_NAME');
  });

  /**
   * §14 ON THIS SURFACE.
   *
   * The MIME walk caps the recorded array and keeps counting, so `attachmentCount` can exceed
   * `attachments.length`. When it does, there are attachments nobody examined — and "not
   * examined" is not "nothing found".
   */
  it('attachments the walk counted but did not record', () => {
    const verdict = attachmentVerdict([attachment()], 12);
    expect(verdict.disposition).toBe('HUMAN_REVIEW');
    expect(verdict.findings.map((f) => f.code)).toContain('UNEXAMINED');
  });

  it('every executable and macro extension in the lists is actually caught', () => {
    // Otherwise an entry could be added to the Set and never consulted, which is how a list
    // becomes documentation.
    for (const ext of [...EXECUTABLE_EXTENSIONS, ...MACRO_EXTENSIONS]) {
      const verdict = attachmentVerdict([attachment({ filename: `file.${ext}` })], 1);
      expect(verdict.disposition, `${ext} was not caught`).toBe('HUMAN_REVIEW');
    }
  });

  it('the gate permits only CLEAR', () => {
    // An equality against the permitting value, so a disposition added later refuses by
    // default rather than inheriting permission — the dispatch gate's `default: return true`.
    expect(attachmentsPermitAutonomy('CLEAR')).toBe(true);
    for (const d of ATTACHMENT_DISPOSITIONS.filter((x) => x !== 'CLEAR')) {
      expect(attachmentsPermitAutonomy(d), `${d} permitted autonomy`).toBe(false);
    }
  });
});

describe('3. the filename is attacker-chosen text and is never printed raw', () => {
  it('direction overrides and control characters are neutralised for display', () => {
    expect(displayName(`invoice${RTLO}fdp.exe`)).not.toContain(RTLO);
    expect(displayName('a\nFAKE LOG LINE')).not.toContain('\n');
    expect(displayName('a\r\nb')).toBe('a??b');
    expect(displayName(null)).toBe('(unnamed)');
    expect(displayName('')).toBe('(unnamed)');
  });

  it('a very long name is truncated', () => {
    expect(displayName('x'.repeat(5000)).length).toBeLessThanOrEqual(120);
  });

  it('the REASON string, which is what gets logged and stored, carries none of it', () => {
    // This is the one that matters. The finding detail reaches a log line and the operator's
    // held-reason field, and a filename that can forge a newline can forge a log entry.
    const verdict = attachmentVerdict(
      [attachment({ filename: `evil${RTLO}\n[INFO] all clear\ntxt.exe` })],
      1
    );
    expect(verdict.reason).not.toBeNull();
    expect(verdict.reason!).not.toContain('\n');
    expect(verdict.reason!).not.toContain(RTLO);
    // ...and it still says what was wrong.
    expect(verdict.reason!).toContain('EXECUTABLE');
  });
});

describe('4. the pipeline holds the draft, and the posture is a control', () => {
  const pipeline = readFileSync('server/services/inboundPipeline.ts', 'utf8');

  it('the verdict decides the outbox status', () => {
    expect(pipeline).toContain('attachmentVerdict');
    expect(pipeline).toMatch(
      /const outboxStatus = attachmentsPermitAutonomy\(attachments\.disposition\)\s*\?\s*sendDisposition\.status\s*:\s*'HUMAN_REVIEW'/
    );
  });

  it('the override can only tighten, never release', () => {
    // `HUMAN_REVIEW` is the held status, so an attachment finding cannot free a draft the
    // auditor held. Stated as a test because the ternary reads equally well the other way
    // round and the wrong way is silent.
    const match =
      /const outboxStatus = attachmentsPermitAutonomy\(attachments\.disposition\)\s*\?\s*([^\n]+?)\s*:\s*('[A-Z_]+')/.exec(
        pipeline
      );
    expect(match, 'the override changed shape').not.toBeNull();
    expect(match![1].trim()).toBe('sendDisposition.status');
    expect(match![2]).toBe("'HUMAN_REVIEW'");
  });

  it('the operator is told which control held it', () => {
    // An attachment finding and an audit objection lead to different actions, and a single
    // "held for review" says neither.
    expect(pipeline).toMatch(/attachments\.reason === null \? auditReason :/);
  });

  it('that check would fail if the override were removed', () => {
    expect(
      /const outboxStatus = attachmentsPermitAutonomy\(attachments\.disposition\)/.test(
        'const outboxStatus = sendDisposition.status;'
      )
    ).toBe(false);
  });
});

describe('5. the guardrail that keeps "we never download attachments" true', () => {
  /**
   * The guardrail is run against a tree that CONTAINS the defect, rather than only against the
   * clean one. A guardrail run on a clean tree is silent whether or not it can still speak —
   * which is the third mutant the autonomy lock work turned up.
   */
  it('fails on a tree that fetches attachment content', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-guard-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'server', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'shared'), { recursive: true });
    cpSync('scripts/check-no-attachment-download.mjs', join(dir, 'scripts', 'check.mjs'));

    // The floor requires a real number of files, so the fixture supplies them. Anything less
    // and the guardrail would exit on the floor rather than on the defect, and this test would
    // pass for the wrong reason.
    for (let i = 0; i < 120; i++) {
      writeFileSync(join(dir, 'server', `f${i}.ts`), 'export const x = 1;\n');
    }
    writeFileSync(join(dir, 'server.ts'), 'export const y = 1;\n');
    writeFileSync(
      join(dir, 'server', 'lib', 'fetcher.ts'),
      'const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/attachments/${aid}`);\n'
    );

    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: dir, encoding: 'utf8' });
    } catch (e: any) {
      failed = true;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, 'the guardrail passed on a tree that downloads attachments').toBe(true);
    expect(output).toContain('ATTACHMENT_FETCH');
  });

  /**
   * THE FLOOR, EXERCISED.
   *
   * A guardrail that scans nothing passes silently and forever. Removing the floor survived the
   * first mutation round because every test ran it against a tree with plenty of files — which
   * is precisely the condition under which a broken walk is indistinguishable from a clean
   * tree.
   */
  it('fails when it scanned too few files to have looked anywhere', () => {
    const dir = mkdtempSync(join(tmpdir(), 'attach-floor-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'server'), { recursive: true });
    cpSync('scripts/check-no-attachment-download.mjs', join(dir, 'scripts', 'check.mjs'));
    writeFileSync(join(dir, 'server', 'only.ts'), 'export const x = 1;\n');

    let failed = false;
    let output = '';
    try {
      execFileSync(process.execPath, ['scripts/check.mjs'], { cwd: dir, encoding: 'utf8' });
    } catch (e: any) {
      failed = true;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(failed, 'the guardrail reported a clean tree after scanning almost nothing').toBe(true);
    expect(output).toMatch(/floor|files scanned/i);
  });

  it('the URL rule survives the comment stripper', () => {
    // The stripper deliberately KEEPS string literals, which is unusual in this repository's
    // guardrails and is load-bearing: a URL path is a string, so stripping them would make
    // ATTACHMENT_FETCH match nothing and the guardrail would pass on a tree that downloads
    // every attachment. Exercised here rather than left to the fixture above, so the reason is
    // attached to the property.
    const guard = readFileSync('scripts/check-no-attachment-download.mjs', 'utf8');
    expect(guard).toContain('Strings are KEPT');
    expect(guard).toMatch(/messages\\\/\[\^'"`\\s\]\*\\\/attachments/);
  });

  it('passes on the tree as it stands', () => {
    // The other half: a guardrail that fails on everything is not a guardrail either.
    const output = execFileSync(
      process.execPath,
      ['scripts/check-no-attachment-download.mjs'],
      { encoding: 'utf8' }
    );
    expect(output).toContain('ok');
  });
});
