import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);
import { memory } from './helpers/memoryDocumentStore';

import {
  IMPORT_FIELDS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  detectDelimiter,
  parseDelimited,
  planImport,
} from '../domain/leadImport';
import { importLeads, planFingerprint, type ImportBatchSettings } from '../services/leadImport.service';
import type { Attribution } from '../domain/operatorAction';

/**
 * INVARIANTS FOR CSV / LIST IMPORT (addendum §2, §11, §14, §16, §18, §34).
 *
 * §2  A preview that writes anything has lied about what it is. Nothing reaches the store
 *     until the operator commits the plan they were shown.
 * §11 The file cannot name its own target field. A column called `consentGiven` writes nothing.
 * §14 Unknown is not permission, per row: a record the gate cannot clear is reported as not
 *     mailable, never created as mailable by default.
 * §16 A re-import can never clear an unsubscribe. The existing record is left untouched.
 * §18 The file is untrusted. A formula does not survive the round trip, and an unterminated
 *     quote refuses rather than swallowing the rest of the file.
 * §34 Formula neutralisation is the exporter's rule applied on the way in, so an injected cell
 *     cannot be laundered through the datastore into the next export.
 *
 * WHY THE ASSERTIONS READ THE STORE RATHER THAN THE RETURN VALUE
 * -------------------------------------------------------------
 * A service that returns a tidy report while writing the wrong document passes every test that
 * only inspects what it handed back. Where the claim is about what was written, these tests
 * read `memory.docs`.
 */

const ORG = 'org-a';
const NOW = new Date('2026-09-15T12:00:00.000Z');
const OPERATOR: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const LI_BATCH: ImportBatchSettings = {
  basis: 'LEGITIMATE_INTEREST',
  liaId: 'lia_2026_q3_uk_b2b',
  country: 'GB',
  addressType: 'ROLE',
  sourceEvidence: 'partner-list-2026-09.csv, supplied by Northwind Events',
};

const HEADER = 'email,firstName,lastName,companyName,country';
const FILE = [
  HEADER,
  'ada@analytical.example,Ada,Lovelace,Analytical Engines,GB',
  'grace@compiler.example,Grace,Hopper,Compiler Works,GB',
].join('\n');

const contacts = () =>
  Object.entries(memory.docs).filter(([k]) => k.startsWith(`organizations/${ORG}/contacts/`));

const storedFor = (id: string) =>
  memory.docs[`organizations/${ORG}/contacts/${id}`] as Record<string, unknown> | undefined;

beforeEach(() => memory.reset());

async function preview(text: string, batch: ImportBatchSettings = LI_BATCH, by: Attribution = OPERATOR) {
  return importLeads(ORG, text, batch, by, { mode: 'PREVIEW', now: NOW });
}

async function commit(text: string, batch: ImportBatchSettings = LI_BATCH) {
  const hash = planFingerprint(text, batch);
  return importLeads(ORG, text, batch, OPERATOR, {
    mode: 'COMMIT',
    expectedPlanHash: hash,
    now: NOW,
  });
}

describe('lead import: a preview writes nothing', () => {
  it('a clean two-row preview leaves the store empty', async () => {
    const outcome = await preview(FILE);
    expect(outcome.ok).toBe(true);
    expect(contacts()).toHaveLength(0);
    expect(memory.docs).toEqual({});
  });

  it('the preview says what a commit would do, and the commit does exactly that', async () => {
    const before = await preview(FILE);
    if (!before.ok) throw new Error('preview refused');
    expect(before.counts.wouldCreate).toBe(2);
    expect(before.counts.created).toBe(0);

    const after = await commit(FILE);
    if (!after.ok) throw new Error('commit refused');
    expect(after.counts.created).toBe(2);
    expect(contacts()).toHaveLength(2);
    expect(after.outcomes.map((o) => o.contactId).sort()).toEqual(
      before.outcomes.map((o) => o.contactId).sort()
    );
  });

  it('a preview of a file that would refuse every row still writes nothing', async () => {
    await preview([HEADER, 'not-an-email,A,B,C,GB'].join('\n'));
    expect(memory.docs).toEqual({});
  });

  it('the preview mailability verdict is the verdict of the document the commit stores', async () => {
    // The dangerous version of this feature previews against a hand-built facts object and
    // writes a different document, so the preview promises sends that never happen.
    const withNotice = [
      'email,companyName,country,article14NoticeSentAt',
      'ada@analytical.example,Analytical,GB,2026-09-10T09:00:00.000Z',
    ].join('\n');
    const p = await preview(withNotice);
    if (!p.ok) throw new Error('preview refused');
    expect(p.outcomes[0].mailable).toBe(true);

    const c = await commit(withNotice);
    if (!c.ok) throw new Error('commit refused');
    expect(c.outcomes[0].mailable).toBe(true);
    expect(storedFor(c.outcomes[0].contactId)!.article14NoticeSentAt).toBe('2026-09-10T09:00:00.000Z');
  });
});

describe('lead import: a re-import cannot undo an unsubscribe', () => {
  it('an existing record is reported as a duplicate and left byte for byte as it was', async () => {
    const first = await commit(FILE);
    if (!first.ok) throw new Error('commit refused');
    const id = first.outcomes[0].contactId;

    // The person unsubscribes.
    memory.docs[`organizations/${ORG}/contacts/${id}`] = {
      ...storedFor(id)!,
      unsubscribed: true,
      suppressed: true,
      suppressionReason: 'UNSUBSCRIBED',
    };
    const snapshot = JSON.stringify(storedFor(id));

    const second = await commit(FILE);
    if (!second.ok) throw new Error('second commit refused');
    expect(second.counts.created).toBe(0);
    expect(second.counts.duplicates).toBe(2);
    expect(JSON.stringify(storedFor(id))).toBe(snapshot);
    expect(storedFor(id)!.unsubscribed).toBe(true);
  });

  it('a duplicate is never reported as mailable, whatever the basis says', async () => {
    await commit(FILE);
    const again = await commit(FILE);
    if (!again.ok) throw new Error('refused');
    expect(again.outcomes.every((o) => o.status === 'DUPLICATE')).toBe(true);
    expect(again.outcomes.every((o) => o.mailable === false)).toBe(true);
  });

  it('a preview marks an existing address as a duplicate rather than as a new lead', async () => {
    await commit(FILE);
    const p = await preview(FILE);
    if (!p.ok) throw new Error('refused');
    expect(p.counts.wouldCreate).toBe(0);
    expect(p.counts.duplicates).toBe(2);
    expect(p.counts.mailable).toBe(0);
  });

  it('a duplicate whose row WOULD have been mailable is still not counted as mailable', async () => {
    // The sharp version of the previous test. There, the rows were unmailable anyway, so a
    // count that ignored the duplicate check would still have read zero. Here every row passes
    // the basis gate, and the only thing keeping the count at zero is that these people are
    // already in the database — possibly with an unsubscribe the import must not walk back.
    const mailableFile = [
      'email,companyName,country,article14NoticeSentAt',
      'ada@analytical.example,Analytical,GB,2026-09-10T09:00:00.000Z',
      'grace@compiler.example,Compiler Works,GB,2026-09-10T09:00:00.000Z',
    ].join('\n');

    const first = await commit(mailableFile);
    if (!first.ok) throw new Error('refused');
    expect(first.counts.mailable).toBe(2);

    const again = await preview(mailableFile);
    if (!again.ok) throw new Error('refused');
    expect(again.counts.duplicates).toBe(2);
    expect(again.counts.mailable).toBe(0);
    expect(again.outcomes.every((o) => o.mailable === false)).toBe(true);
  });
});

describe('lead import: the file cannot name its own target field', () => {
  it('a column called consentGiven writes nothing and is reported as ignored', async () => {
    const text = [
      'email,companyName,country,consentGiven,suppressed,unsubscribed,organizationId',
      'ada@analytical.example,Analytical,GB,true,false,false,other-org',
    ].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.ignoredColumns).toEqual(
      expect.arrayContaining(['consentGiven', 'suppressed', 'unsubscribed', 'organizationId'])
    );
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    // consentGiven exists, and it is FALSE because the batch basis is legitimate interest —
    // derived from the basis, not read from the column that claimed true.
    expect(stored.consentGiven).toBe(false);
    expect(stored.suppressed).toBeUndefined();
    expect(stored.unsubscribed).toBeUndefined();
    expect(stored.organizationId).toBe(ORG);
  });

  it('a column called lawfulBasis cannot set the basis', async () => {
    const text = ['email,country,lawfulBasis', 'ada@analytical.example,GB,CONSENT'].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.ignoredColumns).toContain('lawfulBasis');
    expect(storedFor(outcome.outcomes[0].contactId)!.lawfulBasis).toBe('LEGITIMATE_INTEREST');
  });

  it('the allowlist contains no suppression or consent-state field', () => {
    for (const forbidden of [
      'consentGiven',
      'suppressed',
      'unsubscribed',
      'hardBounced',
      'complained',
      'suppressionReason',
      'lawfulBasis',
      'organizationId',
      'id',
      'type',
      'status',
      'version',
      'aiScore',
      'consentRecordedBy',
    ]) {
      expect(IMPORT_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('an unrecognised header is reported, never guessed at', async () => {
    const text = ['email,country,Owner,Deal Size', 'ada@analytical.example,GB,alice,50000'].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.ignoredColumns).toEqual(['Owner', 'Deal Size']);
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.notes).toBeNull();
  });
});

describe('lead import: injection is neutralised on the way in', () => {
  it('a formula in a company name is stored as text', async () => {
    const text = [
      'email,companyName,country',
      'ada@analytical.example,"=cmd|\' /C calc\'!A0",GB',
    ].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(String(stored.companyName).startsWith("'=")).toBe(true);
  });

  it('every leading character a spreadsheet evaluates is neutralised', async () => {
    for (const leader of ['=', '+', '-', '@']) {
      memory.reset();
      const text = ['email,firstName,country', `ada@analytical.example,"${leader}HYPERLINK(1)",GB`].join('\n');
      const outcome = await commit(text);
      if (!outcome.ok) throw new Error('refused');
      const stored = storedFor(outcome.outcomes[0].contactId)!;
      expect(String(stored.firstName)[0]).toBe("'");
    }
  });
});

describe('lead import: caps refuse rather than truncate', () => {
  it('a file above the row cap refuses, and says how many rows it had', async () => {
    const rows = [HEADER];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i++) rows.push(`p${i}@acme.example,A,B,Acme,GB`);
    const outcome = await preview(rows.join('\n'));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('TOO_MANY_ROWS');
      expect(outcome.message).toContain(String(MAX_IMPORT_ROWS + 1));
    }
    expect(memory.docs).toEqual({});
  });

  it('a file above the byte cap refuses', () => {
    const padding = 'x'.repeat(MAX_IMPORT_BYTES);
    const plan = planImport([HEADER, `ada@analytical.example,${padding},B,Acme,GB`].join('\n'));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('TOO_LARGE');
  });

  it('an over-long cell refuses its row rather than being cut to fit', () => {
    const plan = planImport(
      [HEADER, `ada@analytical.example,${'a'.repeat(501)},B,Acme,GB`].join('\n')
    );
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.rows).toHaveLength(0);
    expect(plan.refused[0].code).toBe('FIELD_TOO_LONG');
  });
});

describe('lead import: the parser', () => {
  it('reads quoted values containing the delimiter, quotes and newlines', () => {
    const parsed = parseDelimited('a,"b,c","d""e","f\ng"\n', ',');
    if (!parsed.ok) throw new Error('parse refused');
    expect(parsed.rows[0]).toEqual(['a', 'b,c', 'd"e', 'f\ng']);
  });

  it('handles CRLF, a trailing newline and a byte-order mark', () => {
    const parsed = parseDelimited('﻿a,b\r\nc,d\r\n', ',');
    if (!parsed.ok) throw new Error('parse refused');
    expect(parsed.rows).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('an unterminated quote refuses instead of swallowing the rest of the file', () => {
    const plan = planImport([HEADER, 'ada@analytical.example,"Ada,Lovelace,Acme,GB', 'grace@compiler.example,G,H,C,GB'].join('\n'));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('UNTERMINATED_QUOTE');
  });

  it('detects semicolon and tab files from the header alone', () => {
    expect(detectDelimiter('email;name;country')).toBe(';');
    expect(detectDelimiter('email\tname\tcountry')).toBe('\t');
    expect(detectDelimiter('email,name,country')).toBe(',');
  });

  it('one value containing a semicolon does not outvote the real delimiter', () => {
    expect(detectDelimiter('email,name,country')).toBe(',');
    const plan = planImport(['email,notes', 'ada@analytical.example,"a; b; c; d; e"'].join('\n'));
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.delimiter).toBe(',');
    expect(plan.rows).toHaveLength(1);
  });

  it('a ragged row refuses rather than shifting every field after the extra comma', () => {
    const plan = planImport([HEADER, 'ada@analytical.example,Ada,Lovelace,Acme, Inc,GB,extra'].join('\n'));
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.rows).toHaveLength(0);
    expect(plan.refused[0].code).toBe('RAGGED_ROW');
  });

  it('a blank trailing line is skipped, not refused', () => {
    const plan = planImport(FILE + '\n\n');
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.rows).toHaveLength(2);
    expect(plan.refused).toHaveLength(0);
  });

  it('every refusal names the line it happened on', () => {
    const plan = planImport(
      [HEADER, 'ada@analytical.example,A,B,C,GB', ',A,B,C,GB', 'nope,A,B,C,GB'].join('\n')
    );
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.refused.map((r) => [r.line, r.code])).toEqual([
      [3, 'NO_EMAIL'],
      [4, 'UNUSABLE_EMAIL'],
    ]);
  });

  it('two columns mapping to the same field refuse, rather than one winning by position', () => {
    const plan = planImport(['email,Email Address,country', 'a@b.example,c@d.example,GB'].join('\n'));
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('DUPLICATE_COLUMN');
  });

  it('a file with no email column refuses and lists the headers it saw', () => {
    const plan = planImport(['name,country', 'Ada,GB'].join('\n'));
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.code).toBe('NO_EMAIL_COLUMN');
      expect(plan.message).toContain('"name"');
    }
  });

  it('the same address twice in one file creates one contact, and names the first line', async () => {
    const text = [HEADER, 'ada@analytical.example,A,B,C,GB', 'ADA@analytical.example,X,Y,Z,GB'].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(1);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0].code).toBe('DUPLICATE_IN_FILE');
    expect(outcome.refused[0].message).toContain('line 2');
    // The FIRST occurrence is the one that was created.
    expect(storedFor(outcome.outcomes[0].contactId)!.firstName).toBe('A');
  });
});

describe('lead import: unknown is not permission, per row', () => {
  it('a row with no country is created and reported as not mailable', async () => {
    const text = ['email,companyName', 'ada@analytical.example,Analytical'].join('\n');
    const outcome = await commit(text, { ...LI_BATCH, country: undefined });
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(1);
    expect(outcome.counts.mailable).toBe(0);
    expect(outcome.outcomes[0].refusalCode).toBe('COUNTRY_UNKNOWN');
  });

  it('a free-mail address on legitimate interest is created and refused', async () => {
    const text = ['email,country', 'ada@gmail.com,GB'].join('\n');
    const outcome = await commit(text);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.mailable).toBe(0);
    expect(outcome.outcomes[0].refusalCode).toBe('LI_INDIVIDUAL_SUBSCRIBER');
  });

  it('legitimate interest without the notice is created and refused, which is the normal case', async () => {
    const outcome = await commit(FILE);
    if (!outcome.ok) throw new Error('refused');
    expect(outcome.counts.created).toBe(2);
    expect(outcome.counts.mailable).toBe(0);
    expect(outcome.counts.notYetMailable).toBe(2);
    expect(outcome.outcomes.every((o) => o.refusalCode === 'LI_NOTICE_NOT_SENT')).toBe(true);
  });

  it('a malformed country refuses the row rather than storing an unreadable one', () => {
    const plan = planImport([HEADER, 'ada@analytical.example,A,B,C,United Kingdom'].join('\n'));
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.refused[0].code).toBe('BAD_COUNTRY');
    expect(plan.rows).toHaveLength(0);
  });

  it('an unreadable notice timestamp refuses the row: it cannot be read as "sent"', () => {
    const plan = planImport(
      ['email,country,noticeSentAt', 'ada@analytical.example,GB,last tuesday'].join('\n')
    );
    if (!plan.ok) throw new Error('plan refused');
    expect(plan.refused[0].code).toBe('BAD_NOTICE_TIMESTAMP');
  });
});

describe('lead import: the batch settings', () => {
  it('an unattributed caller cannot preview or commit', async () => {
    for (const mode of ['PREVIEW', 'COMMIT'] as const) {
      const outcome = await importLeads(ORG, FILE, LI_BATCH, NOBODY, { mode, now: NOW });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    }
    expect(memory.docs).toEqual({});
  });

  it('the importer is recorded on every record as the consent recorder', async () => {
    const outcome = await commit(FILE);
    if (!outcome.ok) throw new Error('refused');
    for (const o of outcome.outcomes) {
      expect(storedFor(o.contactId)!.consentRecordedBy).toBe('ops@abedin.example');
    }
  });

  it('legitimate interest without a balancing assessment refuses the batch, not 2000 rows', async () => {
    const outcome = await preview(FILE, { ...LI_BATCH, liaId: undefined });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_LIA');
  });

  it('consent with no evidence anywhere refuses the batch', async () => {
    const outcome = await preview(FILE, {
      basis: 'CONSENT',
      country: 'GB',
      sourceEvidence: 'webform export',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_CONSENT_EVIDENCE');
  });

  it('consent with a per-row evidence column is accepted, and the row carries its own evidence', async () => {
    const text = [
      'email,country,consentEvidence',
      'ada@analytical.example,GB,webform:pricing 2026-08-01 ip=203.0.113.7',
    ].join('\n');
    const batch: ImportBatchSettings = {
      basis: 'CONSENT',
      country: 'GB',
      sourceEvidence: 'consent platform export 2026-09',
    };
    const outcome = await commit(text, batch);
    if (!outcome.ok) throw new Error('refused');
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.consentGiven).toBe(true);
    expect(stored.consentEvidence).toContain('webform:pricing');
    expect(outcome.counts.mailable).toBe(1);
  });

  it('an import with no statement of where the list came from refuses', async () => {
    for (const sourceEvidence of ['', '   ']) {
      const outcome = await preview(FILE, { ...LI_BATCH, sourceEvidence });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('NO_SOURCE_EVIDENCE');
    }
  });

  it('provenance is written on every record', async () => {
    const outcome = await commit(FILE);
    if (!outcome.ok) throw new Error('refused');
    const stored = storedFor(outcome.outcomes[0].contactId)!;
    expect(stored.source).toBe('IMPORT');
    expect(stored.sourceEvidence).toBe(LI_BATCH.sourceEvidence);
    expect(stored.sourceCollectedAt).toBe(NOW.toISOString());
    expect(stored.importBatchId).toBe(outcome.batchId);
  });
});

describe('lead import: a commit names the plan it commits', () => {
  it('a commit with no hash refuses', async () => {
    const outcome = await importLeads(ORG, FILE, LI_BATCH, OPERATOR, { mode: 'COMMIT', now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PLAN_CHANGED');
    expect(memory.docs).toEqual({});
  });

  it('a commit whose file changed after the preview refuses', async () => {
    const approved = planFingerprint(FILE, LI_BATCH);
    const tampered = FILE + '\nmallory@elsewhere.example,M,M,Elsewhere,GB';
    const outcome = await importLeads(ORG, tampered, LI_BATCH, OPERATOR, {
      mode: 'COMMIT',
      expectedPlanHash: approved,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PLAN_CHANGED');
    expect(memory.docs).toEqual({});
  });

  it('a commit whose BASIS changed after the preview refuses, though the file is identical', async () => {
    // The file is the evidence, and the basis is the decision. Hashing only the file would let
    // a legitimate-interest preview be committed as consent without a byte changing.
    const approved = planFingerprint(FILE, LI_BATCH);
    const outcome = await importLeads(
      ORG,
      FILE,
      { ...LI_BATCH, basis: 'CONSENT', consentEvidence: 'they said so' },
      OPERATOR,
      { mode: 'COMMIT', expectedPlanHash: approved, now: NOW }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('PLAN_CHANGED');
    expect(memory.docs).toEqual({});
  });

  it('the hash a preview returns is the hash a commit accepts', async () => {
    const p = await preview(FILE);
    if (!p.ok) throw new Error('refused');
    const c = await importLeads(ORG, FILE, LI_BATCH, OPERATOR, {
      mode: 'COMMIT',
      expectedPlanHash: p.planHash,
      now: NOW,
    });
    expect(c.ok).toBe(true);
  });
});

describe('lead import: the preview path contains no write', () => {
  /**
   * A source assertion, and deliberately so. Every behavioural test above proves the store was
   * empty AFTER a preview; this one proves the preview branch cannot write at all, which is the
   * property that survives someone adding a "just record the preview" line later.
   *
   * It reads `leadIngest.service.ts`, which is where the write lives: the CSV importer, the
   * discovery provider and the scrape worker all end at that one function, so this assertion
   * covers all three rather than only the source it was written for.
   *
   * Comments are stripped first: the module's own documentation describes the writes it does
   * not perform, and an assertion that matched that text would pass for the wrong reason. That
   * is not hypothetical — it is exactly how `suppression.invariant` came to hold a false green.
   */
  const stripComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

  const source = stripComments(readFileSync('server/services/leadIngest.service.ts', 'utf8'));
  // The preview branch ends at its own return. Slicing to "for (const record of records)"
  // would end it at the FIRST such loop, which is inside the preview branch itself — and a
  // one-line slice would then satisfy "contains no write" for the wrong reason, which is why
  // the length floor below is an assertion rather than a comment.
  const previewEnd = source.indexOf('return { outcomes, wouldCreate, created, duplicates, failed, mailable };');
  const previewBranch = source.slice(source.indexOf("if (options.mode === 'PREVIEW')"), previewEnd);

  it('the preview branch calls no write function', () => {
    expect(previewBranch.length).toBeGreaterThan(200);
    for (const writer of ['createContactIfAbsent', 'tx.set', 'setDoc', 'updateDoc', 'addDoc', 'runTransaction']) {
      expect(previewBranch).not.toContain(writer);
    }
  });

  it('the only store call in the preview branch is the bounded existence check', () => {
    expect(previewBranch).toContain('existingIds');
  });

  it('the commit branch does call the create-or-refuse transaction', () => {
    const commitBranch = source.slice(previewEnd);
    expect(commitBranch).toContain('createContactIfAbsent');
  });

  it('the importer itself holds no write of its own', () => {
    // The refactor that moved the write out is only a gain if nothing grew a second one here.
    const importer = stripComments(readFileSync('server/services/leadImport.service.ts', 'utf8'));
    for (const writer of ['createContactIfAbsent', 'setDoc', 'updateDoc', 'addDoc', 'runTransaction', 'tx.set']) {
      expect(importer).not.toContain(writer);
    }
    expect(importer).toContain('ingestRecords');
  });
});
