import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memory } from './helpers/memoryDocumentStore';
import {
  CONTROLLER_FIELDS,
  buildArticle14Notice,
  escapeHtml,
  readControllerIdentity,
} from '../domain/article14Notice';
import { assessmentVerdict, type LiaRecord } from '../domain/lia';
import type { Attribution } from '../domain/operatorAction';

vi.mock('../store', async () => (await import('./helpers/memoryDocumentStore')).memory.module);

let realSendEnabled = false;
vi.mock('../config/safeMode', async () => {
  const actual = await vi.importActual<typeof import('../config/safeMode')>('../config/safeMode');
  return { ...actual, isRealActionEnabled: () => realSendEnabled };
});

/** What the gateway was asked to do, and what it answers. Set per test. */
let dispatches: any[] = [];
let dispatchResult: any = { success: true, providerResult: { messageId: 'prov-msg-1' } };
vi.mock('../gateway/actionGateway', () => ({
  ActionType: { PRIVACY_NOTICE_SEND: 'PRIVACY_NOTICE_SEND' },
  actionGateway: {
    dispatchAction: async (request: any) => {
      dispatches.push(request);
      return dispatchResult;
    },
  },
}));

const { sendArticle14Notices } = await import('../services/article14Send.service');

/**
 * THE NOTICE THAT NOTHING SENT (§14, §18, §32).
 *
 * `recordArticle14Notice` wrote the field saying a notice had gone out. Nothing sent one. That
 * field is the precondition for legitimate-interest outreach, so an operator's route to a
 * mailable contact was to assert the notice had happened — and the system believed them. A
 * compliance control whose enforcement is an honour system is not a control.
 *
 * FIVE PROPERTIES, EACH A WAY THIS COULD BE WRONG
 * -----------------------------------------------
 * 1. THE SOURCE LINE IS THIS CONTACT'S OWN. Article 14(2)(f) asks which source the data came
 *    from, and a generic template always gets this wrong — telling somebody "from publicly
 *    available sources" when the record was bought is a false statement in the one document
 *    whose purpose is to be accurate. A record with no provenance refuses rather than guessing.
 *
 * 2. IT CANNOT BE SENT WITHOUT A VALID ASSESSMENT. The notice states the basis we intend to
 *    rely on. Asserting a basis that does not hold makes the compliance record itself untrue.
 *
 * 3. AN AMBIGUOUS SEND RECORDS NOTHING (§32). Recording "sent" when it was not marks someone
 *    mailable who was never told where we got their data — a silent legal failure. Recording
 *    "unsent" when it was sent means a duplicate notice, which harms nobody. The asymmetry
 *    decides the lean, and this is the OPPOSITE lean from an ambiguous marketing send.
 *
 * 4. SUPPRESSION STILL REFUSES IT. A duty to inform does not override somebody having said stop.
 *
 * 5. EVERY INTERPOLATED VALUE IS ESCAPED (§18). The company name came off a stranger's web page.
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const ORG = 'org-a';
const NOW = new Date('2026-09-15T10:00:00.000Z');
const NAMED: Attribution = { kind: 'IDENTIFIED', actor: 'ops@abedin.example' };
const NOBODY: Attribution = { kind: 'UNATTRIBUTED', why: 'no verified identity on the request' };

const CONTROLLER = {
  controllerName: 'Abedin Growth Ltd',
  controllerPostalAddress: '12 Example Street, London, EC1A 1AA',
  controllerContactEmail: 'privacy@abedin.example',
  privacyPolicyUrl: 'https://abedin.example/privacy',
  retentionPolicy: 'Two years from last contact, then deleted.',
  supervisoryAuthority: 'You may complain to the Information Commissioner at ico.org.uk.',
  dpoContact: 'No data protection officer is appointed; write to privacy@abedin.example.',
};

const LIA: LiaRecord = {
  id: 'lia_1',
  organizationId: ORG,
  title: 'UK B2B dental practices, Q3 2026',
  purpose: 'To introduce our practice-management software to dental practices that may need it.',
  necessity: 'x'.repeat(200),
  balancing: 'x'.repeat(200),
  countries: ['GB'],
  dataCategories: ['work email address', 'job title', 'employer name'],
  dataSources: ['company website contact pages'],
  safeguards: ['suppression on first objection'],
  objectionRoute: 'Email privacy@abedin.example and we will delete your record.',
  createdAt: '2026-09-01T09:00:00.000Z',
  createdBy: 'ops@abedin.example',
  signedBy: 'dpo@abedin.example',
  signedAt: '2026-09-02T09:00:00.000Z',
  reviewDueAt: '2027-09-02T09:00:00.000Z',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawnReason: null,
  version: 2,
};

const SUBJECT = {
  email: 'info@analytical.example',
  name: 'Ada Lovelace',
  companyName: 'Analytical Engines Ltd',
  source: 'SCRAPE:analytical.example',
  sourceEvidence: 'https://analytical.example/contact',
  sourceCollectedAt: '2026-09-10T08:00:00.000Z',
};

const VERDICT = assessmentVerdict(LIA, { country: 'GB', now: NOW });

function notice(overrides: Partial<typeof SUBJECT> = {}) {
  return buildArticle14Notice({
    controller: CONTROLLER,
    subject: { ...SUBJECT, ...overrides },
    assessment: VERDICT,
    lia: LIA,
  });
}

const contactPath = (id: string) => `organizations/${ORG}/contacts/${id}`;
const stored = (id: string) => memory.docs[contactPath(id)] as Record<string, unknown> | undefined;

function seedContact(id: string, overrides: Record<string, unknown> = {}) {
  memory.docs[contactPath(id)] = {
    id,
    email: 'info@analytical.example',
    name: 'Ada Lovelace',
    companyName: 'Analytical Engines Ltd',
    country: 'GB',
    lawfulBasis: 'LEGITIMATE_INTEREST',
    addressType: 'ROLE',
    liaId: 'lia_1',
    source: 'SCRAPE:analytical.example',
    sourceEvidence: 'https://analytical.example/contact',
    sourceCollectedAt: '2026-09-10T08:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function seedSettings(overrides: Record<string, unknown> = {}) {
  memory.docs[`organizations/${ORG}/settings/main`] = { ...CONTROLLER, ...overrides };
}

function seedLia(overrides: Partial<LiaRecord> = {}) {
  memory.docs[`organizations/${ORG}/legitimateInterestAssessments/lia_1`] = { ...LIA, ...overrides };
}

beforeEach(() => {
  memory.reset();
  dispatches = [];
  dispatchResult = { success: true, providerResult: { messageId: 'prov-msg-1' } };
  realSendEnabled = true;
});

describe('1. the controller details are all-or-nothing', () => {
  it('names every missing field at once, rather than one per round trip', () => {
    const outcome = readControllerIdentity({ controllerName: 'Abedin Growth Ltd' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('CONTROLLER_NOT_CONFIGURED');
    expect([...outcome.missing].sort()).toEqual(
      CONTROLLER_FIELDS.filter((f) => f !== 'controllerName').sort()
    );
  });

  it('a blank string is missing, not configured', () => {
    const outcome = readControllerIdentity({ ...CONTROLLER, dpoContact: '   ' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.missing).toEqual(['dpoContact']);
  });

  it('the DPO line is required even for an organisation that has none', () => {
    // Absent and "none appointed" are different facts, and only one of them is a configured
    // system. Optional would let the notice ship with the line silently missing.
    expect(CONTROLLER_FIELDS).toContain('dpoContact');
    const { dpoContact: _omitted, ...withoutDpo } = CONTROLLER;
    expect(readControllerIdentity(withoutDpo).ok).toBe(false);
  });
});

describe('2. the notice says where THIS record came from', () => {
  it('a scraped record is described as scraped, naming the page', () => {
    const built = notice();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.notice.text).toContain('https://analytical.example/contact');
    expect(built.notice.text).toContain('publicly accessible web page');
    expect(built.notice.text).toContain('not obtained from you directly');
  });

  it('a purchased record is described as purchased, naming the provider', () => {
    const built = notice({ source: 'PROVIDER:acme-data', sourceEvidence: 'UK dental, 50-200 staff' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.notice.text).toContain('third-party data provider, acme-data');
    expect(built.notice.text).not.toContain('publicly accessible web page');
  });

  it('an imported record is described as imported, and a manual one as entered by a person', () => {
    const imported = notice({ source: 'IMPORT', sourceEvidence: 'uk-dental-q3.csv' });
    const manual = notice({ source: 'MANUAL', sourceEvidence: 'met at the BDA conference' });
    if (imported.ok) expect(imported.notice.text).toContain('a list imported into our system');
    if (manual.ok) expect(manual.notice.text).toContain('A member of our team entered it');
  });

  it('a record with NO provenance refuses rather than filling in a plausible guess', () => {
    for (const gap of [{ source: '' }, { sourceEvidence: '   ' }]) {
      const built = notice(gap);
      expect(built.ok, JSON.stringify(gap)).toBe(false);
      if (!built.ok) expect(built.code).toBe('NO_PROVENANCE');
    }
  });
});

describe('3. it cannot state a basis that does not hold', () => {
  it('refuses when the assessment is unsigned, withdrawn or expired', () => {
    for (const broken of [
      { signedAt: null, signedBy: null },
      { withdrawnAt: '2026-09-11T00:00:00.000Z' },
      { reviewDueAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      const verdict = assessmentVerdict({ ...LIA, ...broken } as LiaRecord, { country: 'GB', now: NOW });
      const built = buildArticle14Notice({ controller: CONTROLLER, subject: SUBJECT, assessment: verdict, lia: LIA });
      expect(built.ok, JSON.stringify(broken)).toBe(false);
      if (!built.ok) expect(built.code).toBe('ASSESSMENT_NOT_VALID');
    }
  });

  it('names the assessment and its signature date, so the claim is checkable', () => {
    const built = notice();
    if (!built.ok) throw new Error('expected a notice');
    expect(built.notice.text).toContain('lia_1');
    expect(built.notice.text).toContain('2026-09-02');
  });

  it('states the legitimate interest and the categories from the assessment, not from a template', () => {
    const built = notice();
    if (!built.ok) throw new Error('expected a notice');
    expect(built.notice.text).toContain('practice-management software');
    expect(built.notice.text).toContain('work email address, job title, employer name');
    expect(built.notice.text).toContain('Email privacy@abedin.example and we will delete your record.');
  });
});

describe('4. everything interpolated into the HTML is escaped (§18)', () => {
  it('escapes the five characters that matter, in both positions they appear in', () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    expect(escapeHtml("it's & so")).toBe('it&#39;s &amp; so');
  });

  it('a scraped company name carrying a tag does not reach the HTML body as markup', () => {
    const built = notice({ companyName: '<script>fetch("//evil")</script>' });
    if (!built.ok) throw new Error('expected a notice');
    expect(built.notice.html).not.toContain('<script>');
    expect(built.notice.html).toContain('&lt;script&gt;');
    // And the plain-text part carries it verbatim, which is correct: text/plain is not markup.
    expect(built.notice.text).toContain('<script>');
  });

  it('the ampersand is escaped FIRST, so an escape is not double-escaped', () => {
    // `&lt;` arriving as literal text must become `&amp;lt;`, not stay `&lt;`. Replacing `<`
    // before `&` produces the second, which silently renders attacker-chosen markup.
    expect(escapeHtml('&lt;b&gt;')).toBe('&amp;lt;b&amp;gt;');
  });
});

describe('5. sending: the checks that happen before the network', () => {
  it('refuses an unattributed operator, and dispatches nothing', async () => {
    seedSettings();
    seedLia();
    seedContact('ct_1');
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NOBODY, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('ATTRIBUTION_REQUIRED');
    expect(dispatches.length).toBe(0);
  });

  it('refuses the whole batch when the controller details are missing', async () => {
    seedLia();
    seedContact('ct_1');
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('CONTROLLER_NOT_CONFIGURED');
    expect(dispatches.length).toBe(0);
  });

  it('refuses to SEND while the send flag is off, rather than recording a notice nobody got', async () => {
    realSendEnabled = false;
    seedSettings();
    seedLia();
    seedContact('ct_1');
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('SEND_DISABLED');
    expect(stored('ct_1')!.article14NoticeSentAt).toBeUndefined();
  });

  it('PREVIEW runs every check and dispatches nothing', async () => {
    seedSettings();
    seedLia();
    seedContact('ct_1');
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'PREVIEW', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].sent).toBe(false);
    expect(outcome.outcomes[0].message).toContain('Would send');
    expect(dispatches.length).toBe(0);
    expect(stored('ct_1')!.article14NoticeSentAt).toBeUndefined();
  });

  it('a suppressed contact is refused, and nothing is dispatched for them', async () => {
    seedSettings();
    seedLia();
    for (const [id, flag] of [['ct_u', 'unsubscribed'], ['ct_c', 'complained'], ['ct_b', 'hardBounced'], ['ct_s', 'suppressed']] as const) {
      seedContact(id, { [flag]: true });
    }
    const outcome = await sendArticle14Notices(ORG, ['ct_u', 'ct_c', 'ct_b', 'ct_s'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes.every((o) => o.code === 'SUPPRESSED')).toBe(true);
    expect(dispatches.length).toBe(0);
  });

  it('a contact already noticed is skipped, and the original date stands', async () => {
    seedSettings();
    seedLia();
    seedContact('ct_1', { article14NoticeSentAt: '2026-08-01T09:00:00.000Z' });
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].code).toBe('ALREADY_SENT');
    expect(dispatches.length).toBe(0);
    expect(stored('ct_1')!.article14NoticeSentAt).toBe('2026-08-01T09:00:00.000Z');
  });

  it('a contact whose assessment is withdrawn is refused, individually', async () => {
    seedSettings();
    seedLia({ withdrawnAt: '2026-09-11T00:00:00.000Z', withdrawnReason: 'basis was wrong' });
    seedContact('ct_1');
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].code).toBe('ASSESSMENT_INVALID');
    expect(outcome.outcomes[0].message).toContain('LIA_WITHDRAWN');
    expect(dispatches.length).toBe(0);
  });
});

describe('6. sending: what happens after the network (§32)', () => {
  beforeEach(() => {
    seedSettings();
    seedLia();
    seedContact('ct_1');
  });

  it('a successful send records the notice, the provider id, and makes the contact mailable', async () => {
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].sent).toBe(true);
    expect(stored('ct_1')!.article14NoticeSentAt).toBe(NOW.toISOString());
    expect(stored('ct_1')!.article14NoticeMessageId).toBe('prov-msg-1');
    expect(stored('ct_1')!.article14NoticeRecordedBy).toBe('ops@abedin.example');
  });

  it('the dispatch carries a contactId, a body, and an idempotency key that is not a clock', async () => {
    await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(dispatches.length).toBe(1);
    const payload = dispatches[0].payload;
    expect(dispatches[0].actionType).toBe('PRIVACY_NOTICE_SEND');
    expect(payload.contactId).toBe('ct_1');
    expect(payload.textBody.length).toBeGreaterThan(200);
    expect(payload.htmlBody).toContain('<p>');
    expect(payload.idempotencyKey).toBe('a14:org-a:ct_1:lia_1');
    // Deterministic: the same contact and assessment produce the same key on a later run, which
    // is the whole mechanism by which "did THIS notice go out?" has an answer.
    expect(payload.idempotencyKey).not.toMatch(/\d{10,}/);
  });

  it('A DEFINITE FAILURE records nothing, so the contact stays unmailable', async () => {
    dispatchResult = { success: false, blockedReason: 'no credential', errorCode: 'PROVIDER_NOT_CONFIGURED' };
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].code).toBe('SEND_FAILED');
    expect(stored('ct_1')!.article14NoticeSentAt).toBeUndefined();
  });

  it('AN AMBIGUOUS SEND DOES NOT RECORD THE NOTICE, which is the safe direction here', async () => {
    // Recording "sent" when it was not marks somebody mailable who was never told where we got
    // their data. Recording "unsent" when it was sent means a duplicate notice. Only one of
    // those harms a person, so the lean goes the other way from an ambiguous marketing send.
    dispatchResult = { success: false, requiresReconciliation: true, errorKind: 'TIMEOUT', error: 'timed out after 15000ms' };
    const outcome = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].code).toBe('SEND_AMBIGUOUS');
    expect(stored('ct_1')!.article14NoticeSentAt).toBeUndefined();
    // But it IS recorded as having been attempted, so it is visible rather than lost.
    expect(stored('ct_1')!.article14NoticeAmbiguousAt).toBe(NOW.toISOString());
    expect(stored('ct_1')!.article14NoticeAmbiguousReason).toContain('timed out');
  });

  it('a retry after an ambiguous attempt refuses unless the duplicate is acknowledged', async () => {
    dispatchResult = { success: false, isAmbiguousResult: true, errorKind: 'CONNECTION_FAILED' };
    await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    dispatches = [];
    dispatchResult = { success: true, providerResult: { messageId: 'prov-msg-2' } };

    const blind = await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    expect(blind.ok).toBe(true);
    if (blind.ok) expect(blind.outcomes[0].code).toBe('AMBIGUOUS_ATTEMPT_PENDING');
    expect(dispatches.length).toBe(0);

    const deliberate = await sendArticle14Notices(ORG, ['ct_1'], NAMED, {
      mode: 'SEND',
      acknowledgesPossibleDuplicate: true,
      now: NOW,
    });
    expect(deliberate.ok).toBe(true);
    if (deliberate.ok) expect(deliberate.outcomes[0].sent).toBe(true);
    expect(dispatches.length).toBe(1);
  });

  it('a resolved send clears the pending ambiguity rather than leaving it to confuse the next run', async () => {
    dispatchResult = { success: false, isAmbiguousResult: true, errorKind: 'TIMEOUT' };
    await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    dispatchResult = { success: true, providerResult: { messageId: 'prov-msg-2' } };
    await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', acknowledgesPossibleDuplicate: true, now: NOW });
    expect(stored('ct_1')!.article14NoticeAmbiguousAt).toBeNull();
    expect(stored('ct_1')!.article14NoticeSentAt).toBe(NOW.toISOString());
  });

  it('one contact failing does not stop the rest of the batch', async () => {
    seedContact('ct_2');
    seedContact('ct_3', { unsubscribed: true });
    const outcome = await sendArticle14Notices(ORG, ['ct_1', 'ct_3', 'ct_2', 'ct_missing'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes.map((o) => o.code)).toEqual(['SENT', 'SUPPRESSED', 'SENT', 'NOT_FOUND']);
    expect(dispatches.length).toBe(2);
  });

  /**
   * A MUTATION SURVIVOR FOUND THIS ONE.
   *
   * Adding `unsubscribed: false` to the success write left every test green, because the test
   * below seeds a contact that is already `unsubscribed: false` — so the mutation changed
   * nothing observable. The only way to reach the case is for the unsubscribe to land AFTER the
   * service read the contact and BEFORE the transaction re-reads it, which is exactly the race
   * the "never touch a suppression flag" rule exists for and exactly what happens when somebody
   * clicks the opt-out link in an earlier message while a batch is running.
   *
   * The mock dispatch is the seam: it runs between the two reads, so unsubscribing inside it
   * reproduces the race deterministically.
   */
  it('an unsubscribe landing DURING the send is not cleared by the notice write', async () => {
    dispatchResult = { success: true, providerResult: { messageId: 'prov-msg-1' } };
    const original = memory.docs[contactPath('ct_1')] as Record<string, unknown>;
    let raced = false;
    dispatches = [];
    // Re-point the gateway mock for this test only: it unsubscribes the contact mid-flight.
    const { actionGateway } = await import('../gateway/actionGateway');
    const realDispatch = actionGateway.dispatchAction;
    (actionGateway as any).dispatchAction = async (request: any) => {
      dispatches.push(request);
      memory.docs[contactPath('ct_1')] = { ...original, unsubscribed: true };
      raced = true;
      return dispatchResult;
    };

    try {
      await sendArticle14Notices(ORG, ['ct_1'], NAMED, { mode: 'SEND', now: NOW });
    } finally {
      (actionGateway as any).dispatchAction = realDispatch;
    }

    expect(raced).toBe(true);
    // The notice IS recorded — it genuinely went out — and the unsubscribe SURVIVES it.
    expect(stored('ct_1')!.article14NoticeSentAt).toBe(NOW.toISOString());
    expect(stored('ct_1')!.unsubscribed).toBe(true);
  });

  it('a contact with no assessment is refused as NO_ASSESSMENT, not as a broken one', async () => {
    // The two refusals have different remedies — record a basis, versus fix the assessment —
    // so collapsing them sends the operator to the wrong place. A mutation that removed the
    // first check still refused, on the second, with the wrong code.
    seedContact('ct_nolia', { liaId: undefined });
    const outcome = await sendArticle14Notices(ORG, ['ct_nolia'], NAMED, { mode: 'SEND', now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcomes[0].code).toBe('NO_ASSESSMENT');
    expect(outcome.outcomes[0].message).toContain('cites no balancing assessment');
    expect(dispatches.length).toBe(0);
  });

  it('the notice write touches no suppression flag, no basis and no consent', async () => {
    seedContact('ct_4', { unsubscribed: false, suppressed: false, consentGiven: false });
    await sendArticle14Notices(ORG, ['ct_4'], NAMED, { mode: 'SEND', now: NOW });
    const after = stored('ct_4')!;
    expect(after.unsubscribed).toBe(false);
    expect(after.suppressed).toBe(false);
    expect(after.consentGiven).toBe(false);
    expect(after.lawfulBasis).toBe('LEGITIMATE_INTEREST');
  });
});

describe('7. the source says what the tests say', () => {
  const service = stripComments(readFileSync('server/services/article14Send.service.ts', 'utf8'));
  const gateway = stripComments(readFileSync('server/gateway/actionGateway.ts', 'utf8'));

  it('the ambiguous branch does not write article14NoticeSentAt', () => {
    const at = service.indexOf("requiresReconciliation === true");
    expect(at).toBeGreaterThan(-1);
    const branch = service.slice(at, at + 900);
    expect(branch).toContain('article14NoticeAmbiguousAt');
    expect(branch).not.toContain('article14NoticeSentAt:');
  });

  it('the notice executor does NOT consult the lawful basis, which would be circular', () => {
    const fn = gateway.slice(
      gateway.indexOf('private async executePrivacyNoticeSend'),
      gateway.indexOf('private async executeCalendarCreate')
    );
    expect(fn.length).toBeGreaterThan(500);
    expect(fn).not.toContain('evaluateLawfulBasis');
    expect(fn).not.toContain('evaluateCampaignSafety');
  });

  it('the notice executor DOES check suppression and idempotency before dispatching', () => {
    const fn = gateway.slice(
      gateway.indexOf('private async executePrivacyNoticeSend'),
      gateway.indexOf('private async executeCalendarCreate')
    );
    for (const flag of ['suppressed', 'unsubscribed', 'hardBounced', 'complained']) {
      expect(fn, flag).toContain(flag);
    }
    expect(fn).toContain('article14NoticeSentAt');
    expect(fn).toContain('unsubscribeUrlFor');
    // And the send is the LAST thing: every refusal above returns before it.
    expect(fn.indexOf('gmailService.sendEmail')).toBeGreaterThan(fn.indexOf('article14NoticeSentAt'));
  });

  it('the notice is gated on the same flag as an ordinary send, not one of its own', () => {
    const flagGate = gateway.slice(gateway.indexOf('private checkFeatureFlag'), gateway.indexOf('private checkFeatureFlag') + 700);
    expect(flagGate).toContain('PRIVACY_NOTICE_SEND');
    expect(flagGate).not.toMatch(/PRIVACY_NOTICE_SEND:\s*\n?\s*return isRealActionEnabled\('REAL_(?!EMAIL_SEND)/);
  });
});
