import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { csvField } from '../../shared/lib/csvSafety';
import {
  createContactSchema,
  createKnowledgeItemSchema,
  createOpportunitySchema,
  csvRow,
  MAX_SHORT_STRING,
  MAX_STRING,
  neutralizeCsvCell,
  parseBody,
  project,
} from '../lib/validation';

/**
 * INVARIANTS (addendum §11, §16, §34 / P1.10).
 *
 * §11 Every request body is parsed against a schema before any of it reaches a datastore.
 * §16 A caller cannot set fields the server controls. In particular a caller cannot assert
 *     consent: consent records something that happened in the world, and the request that
 *     creates a contact is not evidence that the contact agreed to be contacted (§14).
 * §34 Exported data cannot execute on the operator's machine.
 *
 * Six handlers built their document with `{ ...req.body, ...ourFields }`. The dangerous field
 * is `consentGiven`, because the action gateway reads it to decide whether a contact may be
 * emailed — so the create endpoint was a way to mint pre-consented recipients.
 */

describe('§16 — a caller cannot set fields the server controls', () => {
  const dangerous = {
    email: 'a@b.com',
    // Every one of these was previously persisted verbatim.
    consentGiven: true,
    consentSource: 'forged',
    suppressed: false,
    suppressionReason: null,
    organizationId: 'someone-elses-org',
    id: 'chosen-by-caller',
    status: 'QUALIFIED',
    version: 99,
    aiScore: 100,
    createdAt: '1999-01-01',
  };

  it('DROPS every server-controlled field', () => {
    const parsed = parseBody(createContactSchema, dangerous);
    expect(parsed.ok).toBe(true);
    if (parsed.ok === false) return;

    for (const field of [
      'consentGiven',
      'consentSource',
      'suppressed',
      'suppressionReason',
      'organizationId',
      'id',
      'status',
      'version',
      'aiScore',
      'createdAt',
    ]) {
      expect(parsed.value, `${field} survived parsing`).not.toHaveProperty(field);
    }
  });

  it('keeps the fields a caller is entitled to set', () => {
    const parsed = parseBody(createContactSchema, {
      ...dangerous,
      name: 'Dave',
      companyName: 'Acme',
    });
    expect(parsed.ok && parsed.value.name).toBe('Dave');
    expect(parsed.ok && parsed.value.companyName).toBe('Acme');
    expect(parsed.ok && parsed.value.email).toBe('a@b.com');
  });

  it('REFUSES a contact with no email at all', () => {
    // Without one there is no identity key and no way to check suppression.
    const parsed = parseBody(createContactSchema, { name: 'Dave' });
    expect(parsed.ok).toBe(false);
  });
});

describe('§11 — types and sizes are enforced', () => {
  it('REFUSES a non-numeric opportunity value rather than producing NaN', () => {
    // `req.body.estimatedValue || req.body.value || 0` accepted a string, and the arithmetic
    // downstream produced NaN which rendered as "NaN".
    const parsed = parseBody(createOpportunitySchema, { estimatedValue: '20000' });
    expect(parsed.ok).toBe(false);
  });

  it('REFUSES a negative or non-finite value', () => {
    for (const value of [-1, Infinity, NaN]) {
      expect(parseBody(createOpportunitySchema, { estimatedValue: value }).ok, String(value)).toBe(false);
    }
  });

  it('REFUSES an oversized string rather than writing an unbounded document', () => {
    const parsed = parseBody(createKnowledgeItemSchema, {
      title: 'x',
      content: 'a'.repeat(MAX_STRING + 1),
    });
    expect(parsed.ok).toBe(false);
  });

  it('REFUSES an oversized short field', () => {
    const parsed = parseBody(createContactSchema, {
      email: 'a@b.com',
      name: 'a'.repeat(MAX_SHORT_STRING + 1),
    });
    expect(parsed.ok).toBe(false);
  });

  it('REFUSES an unbounded array', () => {
    const parsed = parseBody(createKnowledgeItemSchema, {
      title: 'x',
      content: 'y',
      tags: Array.from({ length: 500 }, (_, i) => `t${i}`),
    });
    expect(parsed.ok).toBe(false);
  });

  it('reports which field failed, so the caller can fix it', () => {
    const parsed = parseBody(createKnowledgeItemSchema, { content: 'y' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok === false) {
      expect(parsed.issues.some((i) => i.path === 'title')).toBe(true);
    }
  });

  it('accepts a well-formed body', () => {
    const parsed = parseBody(createKnowledgeItemSchema, {
      title: 'Pricing',
      content: 'The standard plan is ...',
      category: 'COMMERCIAL',
    });
    expect(parsed.ok).toBe(true);
  });

  it('treats a missing body as an empty object rather than throwing', () => {
    expect(() => parseBody(createContactSchema, undefined)).not.toThrow();
    expect(parseBody(createContactSchema, undefined).ok).toBe(false);
  });
});

describe('§16 — responses are projected through an allow-list', () => {
  it('returns only the named fields', () => {
    const stored = {
      id: '1',
      name: 'Dave',
      internalScore: 88,
      accessToken: 'secret',
      organizationId: 'org',
    };
    expect(project(stored, ['id', 'name'])).toEqual({ id: '1', name: 'Dave' });
  });

  it('omits a named field that is absent, rather than inventing undefined', () => {
    expect(project({ id: '1' }, ['id', 'name'])).toEqual({ id: '1' });
  });

  it('handles null and undefined sources', () => {
    expect(project(null, ['id'])).toEqual({});
    expect(project(undefined, ['id'])).toEqual({});
  });
});

describe('§34 — exported cells cannot execute', () => {
  // These exports carry names, subjects and email bodies supplied by external parties, so a
  // formula in a contact name runs on the operator's machine when they open the file.
  const attacks = [
    '=HYPERLINK("http://evil","click")',
    '+1+1',
    '-1+1',
    '@SUM(1:1)',
    '=cmd|\' /C calc\'!A0',
  ];

  for (const attack of attacks) {
    it(`neutralises ${JSON.stringify(attack.slice(0, 20))}`, () => {
      const out = neutralizeCsvCell(attack);
      expect(out.startsWith("'") || out.startsWith('"\'')).toBe(true);
    });
  }

  it('neutralises leading tab and carriage return', () => {
    expect(neutralizeCsvCell('\tfoo').startsWith("'")).toBe(true);
    expect(neutralizeCsvCell('\rfoo').startsWith('"')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(neutralizeCsvCell('Dave Smith')).toBe('Dave Smith');
    expect(neutralizeCsvCell('')).toBe('');
    expect(neutralizeCsvCell(null)).toBe('');
  });

  it('still quotes and escapes properly', () => {
    expect(neutralizeCsvCell('a,b')).toBe('"a,b"');
    expect(neutralizeCsvCell('say "hi"')).toBe('"say ""hi"""');
    // Neutralisation happens BEFORE quoting, so the apostrophe is inside the quotes where the
    // spreadsheet will read it.
    expect(neutralizeCsvCell('=a,b')).toBe('"\'=a,b"');
  });

  it('builds a row with every cell neutralised', () => {
    expect(csvRow(['Dave', '=EVIL()', 'a,b'])).toBe('Dave,\'=EVIL(),"a,b"');
  });
});

describe('§34 — the BROWSER exporter is the one that matters, and it is wired', () => {
  // The neutraliser existing is not the same as the export using it. That distinction is
  // exactly why S18 sat at NOT_STARTED with a sanitiser already in the repository: the
  // function was there, nothing called it.
  const source = readFileSync('src/utils/exportUtils.ts', 'utf8');

  it('imports the shared rule', () => {
    expect(source).toMatch(/import \{ csvField \} from ["'][^"']*shared\/lib\/csvSafety["']/);
  });

  it('builds every field through it', () => {
    expect(source).toContain('csvField(val, { alwaysQuote: true })');
    expect(source).toContain('csvField(h, { alwaysQuote: true })');
  });

  it('no longer hand-rolls the quoting it used instead', () => {
    // The old line was `String(val).replace(/"/g, '""')` wrapped in quotes — correct CSV
    // quoting, and no protection at all, because the spreadsheet strips the quotes first.
    expect(source).not.toMatch(/String\(val\)\.replace\(\/"\/g/);
  });

  it('the always-quoted form still neutralises', () => {
    // The exporter quotes every field. Quoting must not undo the neutralisation, and the
    // apostrophe must end up INSIDE the quotes where the spreadsheet reads it.
    expect(csvField('=HYPERLINK("http://evil","x")', { alwaysQuote: true })).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"'
    );
    expect(csvField('Dave', { alwaysQuote: true })).toBe('"Dave"');
    expect(csvField(null, { alwaysQuote: true })).toBe('""');
  });
});
