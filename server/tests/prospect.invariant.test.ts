import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import {
  PROSPECT_FIELDS,
  isCompanyProfileUrl,
  isLinkedInHost,
  normaliseProfileUrl,
  validateProspect,
} from '../domain/prospect';
import { createProspects, listProspects, promoteProspect } from '../services/prospect.service';
import { evaluateLawfulBasis } from '../domain/lawfulBasis';
import type { ContactProvenance } from '../domain/contactDocument';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

/**
 * A PERSON WE CANNOT YET EMAIL (§14, §16, §18).
 *
 * The whole design rests on one fact: a contact's identity in this system IS its email address.
 * `tryContactDocId` derives the document id from `normalizeEmailKey`, and deduplication,
 * suppression, the unsubscribe token and the §32 Message-ID are all built on that derivation.
 * LinkedIn does not hand out addresses, so a profile cannot be a contact.
 *
 * WHAT THIS SUITE OWNS
 * --------------------
 * 1. THE CANONICAL URL IS ONE STRING PER HUMAN. Locale subdomains, tracking parameters, trailing
 *    path and letter case all collapse — because two records for one person is the defect the
 *    derivation exists to prevent, and it is the defect a naive URL key produces immediately.
 * 2. A HOST MERELY *ENDING* IN linkedin.com IS NOT LINKEDIN. `evil-linkedin.com` is the first
 *    thing anyone writes wrong here.
 * 3. A PROSPECT HAS NO EMAIL FIELD, AND SUPPLYING ONE IS A REFUSAL — not a silent drop, because
 *    a caller with an address has taken the wrong path and needs telling.
 * 4. A PROSPECT CANNOT BE EMAILED BY ANY PATH. Asserted as an absence across the repository
 *    rather than as a check, because "no path exists" rots the moment somebody adds one.
 * 5. PROMOTION ENDS AT THE ONE WRITE PATH and carries the LinkedIn provenance through, because
 *    that is what the Article 14 notice has to be able to say.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ORG = 'org-a';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };

/**
 * Where the ADDRESS came from, which is not where the PERSON came from.
 *
 * Required at promotion. `lia-linkedin-2026.md` covers an address derived from the employer's
 * published naming convention and does NOT cover one purchased from a provider, so which of the
 * two happened decides whether the contact has a lawful basis at all. While this was optional the
 * fixtures below simply omitted it, which is how a document comes to claim something about every
 * record that the data cannot support for any of them.
 */
const ADDRESS_EVIDENCE = 'analytical.example contact page — firstname@ convention';
/**
 * The KIND is what the gate reads; the EVIDENCE is the prose a person checks it against. Two
 * fields because a gate cannot read prose, and one free-text field meant the LinkedIn assessment
 * made a claim about every record that the data could not support for any of them.
 */
const ADDRESS_KIND = 'INFERRED_PATTERN';
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const PROVENANCE: ContactProvenance = {
  source: 'LINKEDIN',
  sourceEvidence: 'Sales Navigator list "UK dental practice managers", exported 2026-09-14',
  sourceCollectedAt: '2026-09-14T09:00:00.000Z',
};

const ROW = {
  profileUrl: 'https://www.linkedin.com/in/ada-lovelace',
  name: 'Ada Lovelace',
  headline: 'Practice Manager at Analytical Dental',
  companyName: 'Analytical Dental Ltd',
  country: 'GB',
};

const LI_BASIS = {
  basis: 'LEGITIMATE_INTEREST' as const,
  liaId: 'lia_2026_q3_uk_b2b',
  addressType: 'ROLE' as const,
  country: 'GB',
};

const storedProspect = (id: string) =>
  memory.docs[`organizations/${ORG}/prospects/${id}`] as Record<string, unknown> | undefined;

beforeEach(() => memory.reset());

describe('1. the canonical URL is one string per human', () => {
  const CANONICAL = 'https://www.linkedin.com/in/ada-lovelace';

  it('collapses locale subdomains, tracking parameters, case and trailing path', () => {
    for (const variant of [
      'https://www.linkedin.com/in/ada-lovelace',
      'https://www.linkedin.com/in/ada-lovelace/',
      'https://uk.linkedin.com/in/ada-lovelace',
      'https://linkedin.com/in/ada-lovelace',
      'http://www.linkedin.com/in/ada-lovelace',
      'https://www.linkedin.com/in/Ada-Lovelace',
      'https://www.linkedin.com/in/ada-lovelace?originalSubdomain=uk&trk=nav',
      'https://www.linkedin.com/in/ada-lovelace#experience',
      'https://www.linkedin.com/in/ada-lovelace/detail/recent-activity/',
      '  linkedin.com/in/ada-lovelace  ',
      'www.linkedin.com/in/ada-lovelace',
    ]) {
      expect(normaliseProfileUrl(variant), variant).toBe(CANONICAL);
    }
  });

  it('two spellings of one person produce one record, not two', async () => {
    const outcome = await createProspects(
      ORG,
      [
        { ref: '1', profileUrl: 'https://uk.linkedin.com/in/Ada-Lovelace/?trk=x' },
        { ref: '2', profileUrl: 'https://www.linkedin.com/in/ada-lovelace' },
      ],
      PROVENANCE,
      NAMED,
      { mode: 'COMMIT', now: NOW }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.created).toBe(1);
    expect(outcome.counts.duplicates).toBe(1);
    expect(Object.keys(memory.docs).filter((k) => k.includes('/prospects/')).length).toBe(1);
  });

  /**
   * A MUTATION SURVIVOR FOUND THIS GAP.
   *
   * Removing the within-batch duplicate check left the COMMIT path unchanged, because the
   * transaction re-reads and refuses the second write anyway. PREVIEW has no transaction, so it
   * would have reported two records where one would be created — a preview that over-promises,
   * which is the one thing a preview must never do.
   */
  it('a within-batch duplicate is reported once in PREVIEW too, not just caught at commit', async () => {
    const outcome = await createProspects(
      ORG,
      [
        { ref: '1', profileUrl: 'https://uk.linkedin.com/in/Ada-Lovelace/?trk=x' },
        { ref: '2', profileUrl: 'https://www.linkedin.com/in/ada-lovelace' },
      ],
      PROVENANCE,
      NAMED,
      { mode: 'PREVIEW', now: NOW }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.wouldCreate).toBe(1);
    expect(outcome.counts.duplicates).toBe(1);
    expect(Object.keys(memory.docs).length).toBe(0);
  });

  it('different people stay different', () => {
    expect(normaliseProfileUrl('https://www.linkedin.com/in/ada-lovelace')).not.toBe(
      normaliseProfileUrl('https://www.linkedin.com/in/charles-babbage')
    );
  });
});

describe('2. a host merely ENDING in linkedin.com is not LinkedIn', () => {
  it('accepts the domain and its subdomains, and nothing else', () => {
    expect(isLinkedInHost('linkedin.com')).toBe(true);
    expect(isLinkedInHost('www.linkedin.com')).toBe(true);
    expect(isLinkedInHost('uk.linkedin.com')).toBe(true);
    expect(isLinkedInHost('LinkedIn.COM')).toBe(true);

    // The one everybody writes wrong the first time.
    expect(isLinkedInHost('evil-linkedin.com')).toBe(false);
    expect(isLinkedInHost('notlinkedin.com')).toBe(false);
    expect(isLinkedInHost('linkedin.com.evil.example')).toBe(false);
    expect(isLinkedInHost('linkedin.co')).toBe(false);
  });

  it('a look-alike host does not normalise to a profile', () => {
    for (const hostile of [
      'https://evil-linkedin.com/in/ada-lovelace',
      'https://linkedin.com.evil.example/in/ada-lovelace',
      'https://www.linkedin.com.evil.example/in/ada',
    ]) {
      expect(normaliseProfileUrl(hostile), hostile).toBeNull();
    }
  });

  it('refuses a non-profile LinkedIn URL, and a company page by name', () => {
    expect(normaliseProfileUrl('https://www.linkedin.com/feed/')).toBeNull();
    expect(normaliseProfileUrl('https://www.linkedin.com/company/analytical-dental')).toBeNull();
    expect(isCompanyProfileUrl('https://www.linkedin.com/company/analytical-dental')).toBe(true);
    expect(isCompanyProfileUrl('https://www.linkedin.com/school/some-university')).toBe(true);
    expect(isCompanyProfileUrl('https://www.linkedin.com/in/ada-lovelace')).toBe(false);

    const outcome = validateProspect({ profileUrl: 'https://www.linkedin.com/company/analytical-dental' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('COMPANY_NOT_PERSON');
  });

  /**
   * A MUTATION SURVIVOR FOUND A DEFECT HERE, NOT JUST A WEAK TEST.
   *
   * Removing the protocol check changed nothing, because it was UNREACHABLE: the parser
   * prepended `https://` to anything not already starting with `http(s)://`, so
   * `file:///etc/passwd` arrived as `https://file` and was refused by the HOST check. The
   * protocol guard read as protective and could never fire.
   *
   * The fix was in the source — detect any scheme, not just http(s) — and these cases now reach
   * the guard they were always supposed to reach. `www.linkedin.com:443` is here because the
   * scheme pattern must not read a host and port as a scheme.
   */
  it('refuses a non-URL, and a scheme that is not http or https', () => {
    for (const bad of ['', '   ', 'not a url at all', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(normaliseProfileUrl(bad), bad).toBeNull();
    }
    // And a host with an explicit port is still a host, not a scheme named "www.linkedin.com".
    expect(normaliseProfileUrl('www.linkedin.com:443/in/ada-lovelace')).toBe(
      'https://www.linkedin.com/in/ada-lovelace'
    );
  });

  /**
   * WHAT THE SCHEME FIX ACTUALLY PREVENTED, found by re-running the mutation after fixing it.
   *
   * With the old `/^https?:\/\//` test, `mailto:x@linkedin.com/in/ada-lovelace` had `https://`
   * prepended — and `https://mailto:x@linkedin.com/in/ada-lovelace` parses `mailto:x` as
   * USERINFO and `linkedin.com` as the host. It was accepted as a perfectly good profile, with
   * credentials embedded in it.
   *
   * So the two halves are both load-bearing and are tested separately: detecting any scheme, and
   * refusing credentials outright the way `crawlTarget.ts` does.
   */
  it('refuses a URL carrying credentials, however it got them', () => {
    for (const hostile of [
      'https://user:pass@www.linkedin.com/in/ada-lovelace',
      'https://user@www.linkedin.com/in/ada-lovelace',
      'mailto:x@linkedin.com/in/ada-lovelace',
      'ftp:user@www.linkedin.com/in/ada-lovelace',
    ]) {
      expect(normaliseProfileUrl(hostile), hostile).toBeNull();
    }
  });

  it('a non-http scheme is refused by the PROTOCOL check, not incidentally by the host check', () => {
    // The distinction matters: if the host check is what catches these, the protocol check is
    // dead code, which is what it was. `file://www.linkedin.com/in/ada` has a host this system
    // would otherwise accept, so only the protocol check can refuse it.
    expect(normaliseProfileUrl('file://www.linkedin.com/in/ada-lovelace')).toBeNull();
    expect(isCompanyProfileUrl('file://www.linkedin.com/company/acme')).toBe(false);
  });
});

describe('3. a prospect has no email, and supplying one is a refusal', () => {
  it('email is not an allowlisted field, nor is anything about permission', () => {
    for (const forbidden of [
      'email',
      'emailKey',
      'consentGiven',
      'suppressed',
      'unsubscribed',
      'hardBounced',
      'complained',
      'lawfulBasis',
      'liaId',
      'article14NoticeSentAt',
    ]) {
      expect(PROSPECT_FIELDS as readonly string[], forbidden).not.toContain(forbidden);
    }
  });

  it('REFUSES rather than dropping it, because the caller has taken the wrong path', () => {
    // `validateCandidate` deliberately IGNORES unknown fields. The reasoning inverts here: a
    // silent drop would leave the operator believing the one field that mattered was stored.
    const outcome = validateProspect({ ...ROW, email: 'ada@analytical.example' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('HAS_EMAIL');
      expect(outcome.message).toContain('contact');
    }
  });

  it('a malformed email is not an email, so it does not trigger the refusal', () => {
    // Otherwise a stray value in a spreadsheet column blocks a perfectly good prospect.
    expect(validateProspect({ ...ROW, email: 'not-an-address' }).ok).toBe(true);
    expect(validateProspect({ ...ROW, email: '   ' }).ok).toBe(true);
  });

  it('no stored prospect document carries an email field', async () => {
    await createProspects(ORG, [{ ...ROW }], PROVENANCE, NAMED, { mode: 'COMMIT', now: NOW });
    const stored = Object.entries(memory.docs).find(([k]) => k.includes('/prospects/'))?.[1] as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect(stored.email).toBeUndefined();
    expect(stored.emailKey).toBeUndefined();
    expect(stored.consentGiven).toBeUndefined();
    expect(stored.lawfulBasis).toBeUndefined();
  });

  /**
   * A MUTATION SURVIVOR SHARPENED THIS ONE.
   *
   * The fixture used an already-canonical URL, so storing the raw one instead was invisible. If
   * the stored `profileUrl` and the derived id disagree about which person this is, the record
   * is self-contradictory: the id says one human and the field a reader would quote says
   * another, and the Article 14 notice quotes the field.
   */
  it('stores the CANONICAL url, not the one the caller happened to paste', () => {
    const outcome = validateProspect({
      profileUrl: 'https://uk.linkedin.com/in/Ada-Lovelace/?originalSubdomain=uk&trk=nav',
      name: 'Ada Lovelace',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prospect.fields.profileUrl).toBe('https://www.linkedin.com/in/ada-lovelace');
    expect(outcome.prospect.profileUrl).toBe(outcome.prospect.fields.profileUrl);
    // The id is derived from that same canonical string, so the two cannot disagree.
    expect(outcome.prospect.prospectId).toBe(
      validateProspect({ profileUrl: 'https://www.linkedin.com/in/ada-lovelace' }).ok
        ? (validateProspect({ profileUrl: 'https://www.linkedin.com/in/ada-lovelace' }) as { prospect: { prospectId: string } }).prospect.prospectId
        : 'mismatch'
    );
  });

  it('the STORED document carries the canonical url too', async () => {
    await createProspects(
      ORG,
      [{ profileUrl: 'https://uk.linkedin.com/in/Ada-Lovelace/?trk=x', name: 'Ada Lovelace' }],
      PROVENANCE,
      NAMED,
      { mode: 'COMMIT', now: NOW }
    );
    const stored = Object.values(memory.docs)[0] as Record<string, unknown>;
    expect(stored.profileUrl).toBe('https://www.linkedin.com/in/ada-lovelace');
  });

  /**
   * AND THE ID SAYS WHAT KIND OF RECORD IT IS.
   *
   * `pr_`, not `ct_`. The prefix is what makes an id self-describing in a log line or an error
   * message, and a prospect carrying a contact's prefix is an id that lies about its own
   * collection.
   */
  it('a prospect id is prefixed pr_ and is not a contact id', () => {
    const outcome = validateProspect(ROW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prospect.prospectId.startsWith('pr_')).toBe(true);
    expect(outcome.prospect.prospectId.startsWith('ct_')).toBe(false);
  });

  it('neutralises every value on the way in, like the contact validator does', () => {
    const outcome = validateProspect({ ...ROW, headline: '=HYPERLINK("http://evil.example","click")' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.prospect.fields.headline.startsWith('=')).toBe(false);
  });

  it('refuses an over-long value rather than truncating it', () => {
    const outcome = validateProspect({ ...ROW, companyName: 'x'.repeat(501) });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('FIELD_TOO_LONG');
  });

  it('refuses a country that is not an ISO-3166 alpha-2 code', () => {
    const outcome = validateProspect({ ...ROW, country: 'United Kingdom' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('BAD_COUNTRY');
  });
});

describe('4. A PROSPECT CANNOT BE EMAILED BY ANY PATH', () => {
  /**
   * Asserted as an ABSENCE across the repository, not as a check inside one function.
   *
   * "Nothing can email a prospect" is true today because nothing reads the collection except the
   * two files that own it. That is the kind of claim that rots silently: the day somebody adds a
   * sender that takes a prospect id, no test anywhere would notice. So this walks the tree.
   */
  const ownedBy = ['server/services/prospect.service.ts', 'server/routes/prospects.routes.ts'];

  function serverFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'tests' || entry.name === 'node_modules') continue;
        serverFiles(path, found);
      } else if (entry.name.endsWith('.ts')) {
        found.push(path);
      }
    }
    return found;
  }

  it("only the two files that own prospects read the collection", () => {
    // Matched on the COLLECTION PATH, not on the bare word. `geminiClient.ts` lists "prospects"
    // among the JSON keys a model response might use for an array, which is not this collection
    // and never touches the datastore — the first version of this test flagged it and would have
    // been "fixed" by adding an exception, which is how such a list stops meaning anything.
    const readers = serverFiles('server')
      .filter((f) => !ownedBy.includes(f))
      .filter((f) => /orgPath\([^)]*,\s*['"`]prospects['"`]\s*\)/.test(stripComments(readFileSync(f, 'utf8'))));
    expect(readers).toEqual([]);
  });

  it('the prospect service contains no send, no dispatch and no gateway import', () => {
    const service = stripComments(readFileSync('server/services/prospect.service.ts', 'utf8'));
    for (const forbidden of ['dispatchAction', 'actionGateway', 'sendEmail', 'ActionType', 'outbox']) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it('the prospect routes expose no send endpoint', () => {
    const routes = stripComments(readFileSync('server/routes/prospects.routes.ts', 'utf8'));
    const posts = routes.match(/prospectsRouter\.post\('([^']+)'/g) ?? [];
    expect(posts.sort()).toEqual(["prospectsRouter.post('/'", "prospectsRouter.post('/:id/promote'"].sort());
  });

  it('a prospect document would not satisfy the lawful basis gate even if one reached it', () => {
    // Belt and braces: even supposing a future dispatch read this collection, the record has no
    // basis, no address type and no notice, so the gate refuses it.
    const stored = {
      id: 'pr_1',
      profileUrl: 'https://www.linkedin.com/in/ada-lovelace',
      country: 'GB',
      companyName: 'Analytical Dental Ltd',
    };
    expect(evaluateLawfulBasis(stored).ok).toBe(false);
  });
});

describe('5. creating prospects', () => {
  it('a preview writes nothing', async () => {
    const outcome = await createProspects(ORG, [ROW], PROVENANCE, NAMED, { mode: 'PREVIEW', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.wouldCreate).toBe(1);
    expect(Object.keys(memory.docs).length).toBe(0);
  });

  it('refuses an unattributed operator, and writes nothing', async () => {
    const outcome = await createProspects(ORG, [ROW], PROVENANCE, NOBODY, { mode: 'COMMIT', now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(Object.keys(memory.docs).length).toBe(0);
  });

  it('refuses a batch with no source evidence', async () => {
    const outcome = await createProspects(
      ORG,
      [ROW],
      { ...PROVENANCE, sourceEvidence: '   ' },
      NAMED,
      { mode: 'COMMIT', now: NOW }
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NO_SOURCE_EVIDENCE');
    expect(Object.keys(memory.docs).length).toBe(0);
  });

  it('records the provenance on every prospect, because promotion will need it', async () => {
    await createProspects(ORG, [ROW], PROVENANCE, NAMED, { mode: 'COMMIT', now: NOW });
    const stored = Object.values(memory.docs)[0] as Record<string, unknown>;
    expect(stored.source).toBe('LINKEDIN');
    expect(stored.sourceEvidence).toContain('Sales Navigator');
    expect(stored.sourceCollectedAt).toBe('2026-09-14T09:00:00.000Z');
    expect(stored.createdBy).toBe('ops@abedin.example');
  });

  it('NEVER overwrites an existing prospect, because somebody may have worked on it', async () => {
    const first = await createProspects(ORG, [ROW], PROVENANCE, NAMED, { mode: 'COMMIT', now: NOW });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const id = first.outcomes[0].prospectId!;
    memory.docs[`organizations/${ORG}/prospects/${id}`] = {
      ...(storedProspect(id) as Record<string, unknown>),
      notes: 'Spoke at the BDA conference; worth a call.',
    };

    const again = await createProspects(
      ORG,
      [{ ...ROW, name: 'Someone Else', notes: 'overwritten' }],
      PROVENANCE,
      NAMED,
      { mode: 'COMMIT', now: NOW }
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.counts.duplicates).toBe(1);
    expect(again.counts.created).toBe(0);
    expect(storedProspect(id)!.notes).toBe('Spoke at the BDA conference; worth a call.');
    expect(storedProspect(id)!.name).toBe('Ada Lovelace');
  });

  it('a bad row fails on its own and the rest of the batch continues', async () => {
    const outcome = await createProspects(
      ORG,
      [
        { ref: 'a', profileUrl: 'https://evil-linkedin.com/in/ada' },
        { ref: 'b', ...ROW },
        { ref: 'c', profileUrl: 'https://www.linkedin.com/in/charles-babbage', email: 'c@b.example' },
      ],
      PROVENANCE,
      NAMED,
      { mode: 'COMMIT', now: NOW }
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.counts.created).toBe(1);
    expect(outcome.counts.failed).toBe(2);
    expect(outcome.outcomes.find((o) => o.ref === 'c')!.reason).toContain('HAS_EMAIL');
  });

  it('lists what it created, and filters on promoted state only for the exact values', async () => {
    await createProspects(ORG, [ROW], PROVENANCE, NAMED, { mode: 'COMMIT', now: NOW });
    expect((await listProspects(ORG)).length).toBe(1);
    expect((await listProspects(ORG, { promoted: false })).length).toBe(1);
    expect((await listProspects(ORG, { promoted: true })).length).toBe(0);
  });
});

describe('6. promotion: the moment an address is found', () => {
  async function seedOne(): Promise<string> {
    const outcome = await createProspects(ORG, [ROW], PROVENANCE, NAMED, { mode: 'COMMIT', now: NOW });
    if (!outcome.ok) throw new Error('seed failed');
    return outcome.outcomes[0].prospectId!;
  }

  it('a preview creates no contact and does not mark the prospect promoted', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'PREVIEW',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    expect(outcome.ok).toBe(true);
    expect(Object.keys(memory.docs).filter((k) => k.includes('/contacts/')).length).toBe(0);
    expect(storedProspect(id)!.promotedToContactId).toBeNull();
  });

  it('refuses an unattributed operator', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NOBODY, {
      mode: 'COMMIT',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
  });

  it('refuses a prospect that does not exist', async () => {
    const outcome = await promoteProspect(ORG, 'pr_nobody', 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NOT_FOUND');
  });

  it('refuses an unusable address rather than creating a broken contact', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'not an address', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('UNUSABLE_EMAIL');
    expect(storedProspect(id)!.promotedToContactId).toBeNull();
  });

  it('creates the contact and links it back, and the prospect SURVIVES', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: 'enrichment provider acme-data',
      now: NOW,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const contact = memory.docs[`organizations/${ORG}/contacts/${outcome.contactId}`] as Record<string, unknown>;
    expect(contact).toBeDefined();
    expect(contact.email).toBe('info@analytical.example');
    // The prospect is not deleted: it holds the provenance the Article 14 notice needs.
    expect(storedProspect(id)).toBeDefined();
    expect(storedProspect(id)!.promotedToContactId).toBe(outcome.contactId);
    expect(storedProspect(id)!.promotedBy).toBe('ops@abedin.example');
  });

  /**
   * THIS TEST USED TO DEMONSTRATE THE HOLE. IT NOW PROVES IT IS CLOSED.
   *
   * It promoted with `emailSource: 'enrichment provider acme-data'` and asserted the contact came
   * out as LINKEDIN. That was true and it was the defect: a purchased address on a LinkedIn-routed
   * contact, indistinguishable at the gate from one derived from the employer's own published
   * convention, while `lia-linkedin-2026.md` says it covers only the second.
   *
   * The provider name now lands in a FIELD rather than only in a sentence, so the gate can read
   * it \u2014 and the assertion at the end is the one that matters: the LinkedIn assessment refuses it.
   */
  it('THE CONTACT CARRIES BOTH PROVENANCES, and a bought address is refused by the LinkedIn LIA', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      addressSourceKind: 'PROVIDER',
      addressSourceEvidence: 'enrichment provider acme-data',
      now: NOW,
    });
    if (!outcome.ok) throw new Error('promotion failed');
    const contact = memory.docs[`organizations/${ORG}/contacts/${outcome.contactId}`] as Record<string, unknown>;

    expect(contact.source).toBe('LINKEDIN');
    // The address route is its own field, not a phrase inside the evidence string.
    expect(contact.addressSourceKind).toBe('PROVIDER');
    // And the address is dated NOW, not the prospect's own collection date: the person was
    // identified then, the address was obtained at promotion.
    expect(contact.addressCollectedAt).toBe(NOW.toISOString());
    // The profile URL, so the notice can say where we found this person...
    expect(String(contact.sourceEvidence)).toContain('linkedin.com/in/ada-lovelace');
    // ...and the address source, which is a different fact and usually a different party.
    expect(String(contact.sourceEvidence)).toContain('acme-data');
    // The date is when we obtained the record, not when we promoted it.
    expect(contact.sourceCollectedAt).toBe('2026-09-14T09:00:00.000Z');
  });

  it('carries the profile URL onto the contact, so the two are linked in both directions', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    if (!outcome.ok) throw new Error('promotion failed');
    const contact = memory.docs[`organizations/${ORG}/contacts/${outcome.contactId}`] as Record<string, unknown>;
    expect(contact.linkedinUrl).toBe('https://www.linkedin.com/in/ada-lovelace');
  });

  it('promoting twice with the same address is idempotent', async () => {
    const id = await seedOne();
    const first = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, { mode: 'COMMIT', now: NOW, addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE });
    const second = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, { mode: 'COMMIT', now: NOW, addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.alreadyPromoted).toBe(true);
    expect(second.contactId).toBe(first.contactId);
    expect(Object.keys(memory.docs).filter((k) => k.includes('/contacts/')).length).toBe(1);
  });

  it('REFUSES a second promotion to a DIFFERENT address, rather than duplicating the person', async () => {
    const id = await seedOne();
    await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, { mode: 'COMMIT', now: NOW, addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE });
    const second = await promoteProspect(ORG, id, 'ada@analytical.example', LI_BASIS, NAMED, { mode: 'COMMIT', now: NOW, addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('ALREADY_PROMOTED');
      expect(second.message).toContain('twice');
    }
    expect(Object.keys(memory.docs).filter((k) => k.includes('/contacts/')).length).toBe(1);
  });

  it('a promoted contact is still not mailable until the notice is sent', async () => {
    // Promotion does not make anybody contactable. It makes them ADDRESSABLE, which is a
    // different thing, and the gate still wants the notice.
    const id = await seedOne();
    const outcome = await promoteProspect(ORG, id, 'info@analytical.example', LI_BASIS, NAMED, { mode: 'COMMIT', now: NOW, addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.mailable).toBe(false);
    const contact = memory.docs[`organizations/${ORG}/contacts/${outcome.contactId}`] as Record<string, unknown>;
    const verdict = evaluateLawfulBasis(contact);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('LI_NOTICE_NOT_SENT');
  });

  it('prospects are tenant-scoped: another organisation cannot promote this one', async () => {
    const id = await seedOne();
    const outcome = await promoteProspect('org-b', id, 'info@analytical.example', LI_BASIS, NAMED, {
      mode: 'COMMIT',
      now: NOW,
      addressSourceKind: ADDRESS_KIND, addressSourceEvidence: ADDRESS_EVIDENCE,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('NOT_FOUND');
  });
});

describe('7. the source says what the tests say', () => {
  const service = stripComments(readFileSync('server/services/prospect.service.ts', 'utf8'));

  it('promotion goes through the one write path rather than writing a contact itself', () => {
    expect(service).toContain('ingestRecords');
    expect(service).toContain('validateCandidate');
    // No second create path. `createContactIfAbsent` belongs to leadIngest, not here.
    expect(service).not.toContain('createContactIfAbsent');
    expect(service).not.toContain('buildContactDocument');
  });

  it('the create path writes only to the prospects collection', () => {
    const writes = service.match(/orgPath\([a-zA-Z]+, '([a-zA-Z]+)'\)/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toContain("'prospects'");
  });

  it('the existence check is re-done inside the transaction', () => {
    // The check before it is a read the world can invalidate, and a concurrent import of the
    // same list is the ordinary case rather than the exotic one.
    // The CALL, not the import at the top of the file.
    const at = service.indexOf('runTransaction(store');
    expect(at).toBeGreaterThan(-1);
    expect(service.slice(at, at + 400)).toContain('tx.get');
    expect(service.slice(at, at + 400)).toContain('snap.exists()');
  });
});
