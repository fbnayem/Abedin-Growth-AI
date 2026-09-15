import { collection, doc, getDoc, getDocs, query, store, where } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { safeModeSnapshot } from '../config/safeMode';
import { readControllerIdentity } from '../domain/article14Notice';
import { livenessVerdict, type LiaRecord } from '../domain/lia';
import { unreviewedCountries } from '../domain/lawfulBasisSources';
import { evaluateLawfulBasis } from '../domain/lawfulBasis';
import { evaluateCampaignSafety } from '../domain/campaignSafety';
import { unsubscribeUrlFor } from '../domain/unsubscribe';
import { senderPostureFor } from '../services/deliverability.service';
import { domainOfAddress, posturePermitsSending } from '../domain/senderIdentity';
import { normalizeScopes } from '../lib/capabilities';
import { isFabricatedProviderId } from '../lib/providerId';
import { outreachPreflight, type PreflightFacts } from '../domain/outreachPreflight';

/**
 * GATHERING THE FACTS THE READINESS REPORT JUDGES.
 *
 * `server/domain/outreachPreflight.ts` holds the rules and is pure. This file does the reading,
 * and its one job is to distinguish THREE outcomes for every fact, not two:
 *
 *   the thing is there          -> true
 *   the thing is not there      -> false
 *   we could not find out       -> null
 *
 * The third is the one that matters. Every `catch` here yields `null` rather than `false`,
 * because "the settings document could not be read" and "the settings document is empty" are
 * different facts, and only one of them is fixed by filling in a form. The domain module treats
 * null as UNKNOWN and UNKNOWN blocks, so a datastore outage during a preflight reports "not
 * ready, could not check" instead of a confident wrong answer in either direction.
 *
 * Nothing here writes. A readiness check that changed state would be a readiness check people
 * were afraid to run.
 */

const SAMPLE_LIMIT = 500;

function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Which campaign guards cannot run, asked of the same inputs the gateway actually supplies. */
function guardsThatCannotRun(): string[] {
  // Mirrors `executeEmailSend`. Deliberately reconstructed rather than imported from it: the
  // gateway builds this object inline, and a preflight that guessed at the shape would drift
  // from what actually gets enforced. The invariant suite pins the two together.
  const decision = evaluateCampaignSafety({
    suppressed: false,
    hardBounced: false,
    complained: false,
    wrongPerson: false,
    isExistingCustomer: undefined,
    hasActiveConversation: undefined,
    hasPendingHumanReply: undefined,
    contactHistoryLoaded: false,
    campaignMembershipLoaded: false,
    recipientsToday: undefined,
    sendsToThisDomainToday: undefined,
    recipientLocalHour: undefined,
  });
  return [...decision.notRun];
}

async function readControllerGaps(orgId: string): Promise<readonly string[] | null> {
  try {
    if (!store) return null;
    const snap = await getDoc(doc(store, orgPath(orgId, 'settings'), 'main'));
    const settings = (snap.exists() ? (snap.data() as Record<string, unknown>) : {}) ?? {};
    const outcome = readControllerIdentity(settings);
    return outcome.ok ? [] : outcome.code === 'CONTROLLER_NOT_CONFIGURED' ? outcome.missing : ['(a field is too long)'];
  } catch {
    return null;
  }
}

async function countUsableAssessments(orgId: string, now: Date): Promise<number | null> {
  try {
    if (!store) return null;
    const snap = await getDocs(collection(store, orgPath(orgId, 'legitimateInterestAssessments')));
    let usable = 0;
    for (const d of snap.docs) {
      const record = d.data() as unknown as LiaRecord;
      // Liveness, not coverage: signed, unwithdrawn, in date. Whether it covers any particular
      // contact is a per-contact question and is asked at send time.
      if (livenessVerdict(record, now).ok) usable += 1;
    }
    return usable;
  } catch {
    return null;
  }
}

async function readGmailCredential(orgId: string): Promise<{ usable: boolean | null; capable: boolean | null }> {
  try {
    if (!store) return { usable: null, capable: null };
    const snap = await getDocs(
      query(collection(store, 'oauth_connections'), where('organizationId', '==', orgId))
    );
    let usable = false;
    let capable = false;
    let found = false;
    snap.forEach((d) => {
      const data = d.data();
      if (data.provider !== 'gmail' && data.provider !== 'GMAIL') return;
      found = true;
      const token = typeof data.accessToken === 'string' ? data.accessToken : null;
      if (token !== null && token !== 'mock_token' && !isFabricatedProviderId(token)) usable = true;
      if ((normalizeScopes(data.scopes) ?? []).includes('EMAIL_SEND')) capable = true;
    });
    // No connection at all is a definite "no", not an unknown: we successfully read the
    // collection and there was nothing in it.
    return { usable, capable: found ? capable : false };
  } catch {
    return { usable: null, capable: null };
  }
}

async function readSenderPosture(
  orgId: string
): Promise<{ domain: string; permitted: boolean; reason: string } | null> {
  try {
    if (!store) return null;
    const snap = await getDocs(
      query(collection(store, 'oauth_connections'), where('organizationId', '==', orgId))
    );
    const addresses: string[] = [];
    snap.forEach((d) => {
      const data = d.data();
      if (data.provider === 'gmail' || data.provider === 'GMAIL') {
        const found = trimmedOrNull(data.emailAddress) ?? trimmedOrNull(data.email);
        if (found !== null) addresses.push(found);
      }
    });
    const domain = domainOfAddress(addresses[0] ?? null);
    if (domain === null) return null;
    const cached = await senderPostureFor(domain);
    return {
      domain,
      permitted: posturePermitsSending(cached.posture),
      // The verdict and its reasons, not a bare boolean: WEAK permits sending and is worth
      // seeing, and an operator reading "blocked" wants to know which record was missing.
      reason: `${cached.posture.verdict} — ${cached.posture.reasons.join('; ')}`,
    };
  } catch {
    return null;
  }
}

async function countMailable(orgId: string, now: Date): Promise<number | null> {
  try {
    if (!store) return null;
    const snap = await getDocs(collection(store, orgPath(orgId, 'contacts')));
    let mailable = 0;
    let seen = 0;
    for (const d of snap.docs) {
      if (seen >= SAMPLE_LIMIT) break;
      seen += 1;
      const contact = d.data() as Record<string, unknown>;
      if (contact.suppressed === true || contact.unsubscribed === true) continue;
      // Evaluated WITHOUT the strict options, deliberately: this answers "how many have a basis
      // recorded", and the strict checks are reported as their own lines above. Folding them in
      // would make one number mean four things and hide which one is the problem.
      if (evaluateLawfulBasis(contact).ok) mailable += 1;
    }
    return mailable;
  } catch {
    return null;
  }
}

/** Gather everything, then judge it. Returns exactly what the domain module returns. */
export async function outreachReadiness(orgId: string, now: Date = new Date()) {
  const [controllerGaps, assessments, credential, posture, mailable] = await Promise.all([
    readControllerGaps(orgId),
    countUsableAssessments(orgId, now),
    readGmailCredential(orgId),
    readSenderPosture(orgId),
    countMailable(orgId, now),
  ]);

  // A representative contact id, because the unsubscribe URL is per-contact and the question is
  // whether one can be built at all — the secret and the base URL are what actually decide it.
  const unsubscribe = unsubscribeUrlFor({ orgId, contactId: 'preflight_probe' });

  const facts: PreflightFacts = {
    flags: safeModeSnapshot(),
    missingControllerFields: controllerGaps,
    usableAssessments: assessments,
    unreviewedCountries: unreviewedCountries(),
    gmailCredential: credential.usable,
    sendCapability: credential.capable,
    senderPosture: posture,
    messageIdDomain: trimmedOrNull(process.env.OUTBOUND_MESSAGE_ID_DOMAIN),
    unsubscribeConfigured: unsubscribe.ok,
    guardsThatCannotRun: guardsThatCannotRun(),
    mailableContacts: mailable,
  };

  return { ...outreachPreflight(facts), facts };
}
