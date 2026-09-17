import { doc, getDoc, runTransaction, store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { ActionType, actionGateway } from '../gateway/actionGateway';
import { isRealActionEnabled } from '../config/safeMode';
import { buildArticle14Notice, readControllerIdentity, type NoticeSubject } from '../domain/article14Notice';
import { assessmentVerdict, type LiaRecord } from '../domain/lia';
import { getAssessment } from './lia.service';
import type { Attribution } from '../domain/operatorAction';

/**
 * SENDING THE ARTICLE 14 NOTICE, WHICH NOTHING PREVIOUSLY DID (§14, §32, §C).
 *
 * `recordArticle14Notice` wrote the field that says a notice was sent. This sends one. The two
 * are deliberately still separate functions — an operator who sent the notice by some other
 * route (a mail merge, a letter) needs to be able to record that, and removing the manual path
 * would push them into lying to the system instead.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ------------------------------------
 * Everything that can refuse, refuses BEFORE the network. Then the send happens. Then the
 * record is written, and only if the send actually succeeded. A failure at any earlier stage
 * costs nothing; a failure after the send is the case §32 is about.
 *
 *   1. identified operator
 *   2. the controller identity is configured        (seven fields, all or nothing)
 *   3. the contact exists and is not suppressed
 *   4. the notice has not already been sent
 *   5. the assessment resolves: signed, unwithdrawn, in date, covering this country
 *   6. the notice builds, including the source line from this contact's own provenance
 *   7. the gateway dispatches it                    <- the only irreversible step
 *   8. the record is written
 *
 * WHAT AN AMBIGUOUS SEND DOES, AND WHY IT IS NOT WHAT EMAIL_SEND DOES (§32)
 * ------------------------------------------------------------------------
 * A timeout means the notice may or may not have reached the person. Two harms are available
 * and they are not symmetric:
 *
 *   record it as sent when it was not   ->  this person is marked mailable and receives
 *                                           marketing without ever having been told where we
 *                                           got their data. A legal failure, and a silent one.
 *   record it as unsent when it was     ->  this person may later receive the same notice
 *                                           twice. Untidy. Nobody is harmed.
 *
 * So the ambiguous case FAILS CLOSED ON PERMISSION: `article14NoticeSentAt` is NOT written, the
 * contact stays unmailable, and the attempt is recorded separately as ambiguous so it is
 * visible rather than lost. A retry is then allowed, but only with
 * `acknowledgesPossibleDuplicate`, so sending a second copy is a decision somebody makes rather
 * than something a backoff loop does on their behalf.
 *
 * This is deliberately the opposite lean from an ambiguous marketing send, where a duplicate IS
 * the harm. Same rule underneath — never let an unknown become a permission — pointing in a
 * different direction because the permission is on the other side.
 */

export type NoticeSendRefusal =
  | 'STORE_UNAVAILABLE'
  | 'ATTRIBUTION_REQUIRED'
  | 'NOT_FOUND'
  | 'SUPPRESSED'
  | 'ALREADY_SENT'
  | 'AMBIGUOUS_ATTEMPT_PENDING'
  | 'CONTROLLER_NOT_CONFIGURED'
  | 'NO_ASSESSMENT'
  | 'ASSESSMENT_INVALID'
  | 'NOTICE_NOT_BUILDABLE'
  | 'SEND_DISABLED'
  | 'SEND_FAILED'
  | 'SEND_AMBIGUOUS';

export interface NoticeSendOutcome {
  readonly contactId: string;
  readonly sent: boolean;
  readonly code: 'SENT' | NoticeSendRefusal;
  readonly message: string;
  /** Present only on a real send: what the provider returned, never something we minted. */
  readonly providerMessageId?: string;
}

export interface NoticeSendOptions {
  readonly mode: 'PREVIEW' | 'SEND';
  /** Required to retry a contact whose previous attempt was ambiguous. */
  readonly acknowledgesPossibleDuplicate?: boolean;
  readonly now?: Date;
}

/** No more than this many per call, so one request cannot become an unbounded send loop. */
export const MAX_NOTICE_BATCH = 200;

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function contactRef(orgId: string, contactId: string) {
  return doc(store, orgPath(orgId, 'contacts'), contactId);
}

/** The subject fields the notice needs, read off a contact document. */
function subjectFrom(contact: Record<string, unknown>): NoticeSubject {
  return {
    email: trimmed(contact.email) ?? '',
    name: trimmed(contact.name) ?? '',
    companyName: trimmed(contact.companyName) ?? '',
    source: trimmed(contact.source) ?? '',
    sourceEvidence: trimmed(contact.sourceEvidence) ?? '',
    sourceCollectedAt: trimmed(contact.sourceCollectedAt) ?? trimmed(contact.createdAt) ?? '',
  };
}

function refuse(contactId: string, code: NoticeSendRefusal, message: string): NoticeSendOutcome {
  return { contactId, sent: false, code, message };
}

/**
 * Send the Article 14 notice to a batch of contacts.
 *
 * PREVIEW runs every check and stops before the gateway, so an operator can see exactly which
 * contacts would receive a notice and what each one would say, without anything leaving the
 * process. That is the same shape the importer and the discovery service use, for the same
 * reason: the expensive, irreversible step should never be the first time you find out.
 */
export async function sendArticle14Notices(
  orgId: string,
  contactIds: readonly string[],
  by: Attribution,
  options: NoticeSendOptions = { mode: 'PREVIEW' }
): Promise<
  | { readonly ok: true; readonly mode: 'PREVIEW' | 'SEND'; readonly outcomes: NoticeSendOutcome[] }
  | { readonly ok: false; readonly code: NoticeSendRefusal; readonly message: string }
> {
  if (!store) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'The datastore is not available.' };
  }
  if (by.kind !== 'IDENTIFIED') {
    return {
      ok: false,
      code: 'ATTRIBUTION_REQUIRED',
      message:
        `Sending a data-subject notice needs an identified operator: ${by.why}. It emails people ` +
        `who have never heard of us and it records that a legal obligation was discharged; both ` +
        `need a name against them.`,
    };
  }
  const actor = by.actor;
  const now = options.now ?? new Date();
  const ids = contactIds.slice(0, MAX_NOTICE_BATCH);

  // The controller identity is organisation-wide, so it is read once and refuses the whole
  // batch rather than each contact separately. A notice missing its controller details is not
  // a notice, and reporting that two hundred times would bury the single thing to fix.
  const settingsSnap = await getDoc(doc(store, orgPath(orgId, 'settings'), 'main'));
  const controller = readControllerIdentity(
    (settingsSnap.exists() ? (settingsSnap.data() as Record<string, unknown>) : {}) ?? {}
  );
  if (!controller.ok) {
    return { ok: false, code: 'CONTROLLER_NOT_CONFIGURED', message: controller.message };
  }

  if (options.mode === 'SEND' && !isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')) {
    return {
      ok: false,
      code: 'SEND_DISABLED',
      message:
        'Real email sending is disabled. REAL_EMAIL_SEND_ENABLED is not set to "true" and it ' +
        'fails closed, so the notice would not have gone out — and recording it as sent would ' +
        'make every contact in this batch mailable on the strength of a message nobody received.',
    };
  }

  // Assessments are cached per id across the batch. A batch is normally one basis, so this is
  // one read instead of two hundred, and it cannot go stale within a single call.
  const assessments = new Map<string, LiaRecord | null>();
  const outcomes: NoticeSendOutcome[] = [];

  for (const contactId of ids) {
    const snap = await getDoc(contactRef(orgId, contactId));
    if (!snap.exists()) {
      outcomes.push(refuse(contactId, 'NOT_FOUND', `No contact ${contactId} in this organisation.`));
      continue;
    }
    const contact = snap.data() as Record<string, unknown>;

    const suppression = [
      contact.suppressed === true ? 'SUPPRESSED' : null,
      contact.unsubscribed === true ? 'UNSUBSCRIBED' : null,
      contact.hardBounced === true ? 'HARD_BOUNCE' : null,
      contact.complained === true ? 'SPAM_COMPLAINT' : null,
    ].filter(Boolean);
    if (suppression.length > 0) {
      outcomes.push(
        refuse(
          contactId,
          'SUPPRESSED',
          `Suppressed (${suppression.join(', ')}). The notice is refused too: a duty to inform ` +
            `does not override somebody having told us to stop. Delete the record instead.`
        )
      );
      continue;
    }

    const already = trimmed(contact.article14NoticeSentAt);
    if (already !== null) {
      outcomes.push(
        refuse(contactId, 'ALREADY_SENT', `A notice was already sent at ${already}; nothing to do.`)
      );
      continue;
    }

    const ambiguousAt = trimmed(contact.article14NoticeAmbiguousAt);
    if (ambiguousAt !== null && options.acknowledgesPossibleDuplicate !== true) {
      outcomes.push(
        refuse(
          contactId,
          'AMBIGUOUS_ATTEMPT_PENDING',
          `A previous attempt at ${ambiguousAt} neither succeeded nor definitely failed, so this ` +
            `person may already have the notice. Retrying may send a second copy: re-run with ` +
            `acknowledgesPossibleDuplicate to do that deliberately.`
        )
      );
      continue;
    }

    const liaId = trimmed(contact.liaId);
    if (liaId === null) {
      outcomes.push(
        refuse(
          contactId,
          'NO_ASSESSMENT',
          'This contact cites no balancing assessment. The notice states the legal basis we ' +
            'intend to rely on, so there is nothing truthful to write until one exists.'
        )
      );
      continue;
    }
    if (!assessments.has(liaId)) {
      assessments.set(liaId, await getAssessment(orgId, liaId));
    }
    const record = assessments.get(liaId) ?? null;
    const country = trimmed(contact.country) ?? '';
    // The contact's own source, for the second dimension of coverage. This matters more here
    // than anywhere else: the notice's first substantive paragraph tells the person WHERE WE GOT
    // THEIR DETAILS, so sending it under an assessment written about a different route would put
    // a statement about one acquisition next to a signature given for another.
    const verdict = assessmentVerdict(record, {
      country,
      source: contact.source,
      addressSourceKind: contact.addressSourceKind,
      now,
    });
    if (!verdict.ok) {
      outcomes.push(refuse(contactId, 'ASSESSMENT_INVALID', `${verdict.code}: ${verdict.message}`));
      continue;
    }

    const built = buildArticle14Notice({
      controller: controller.controller,
      subject: subjectFrom(contact),
      assessment: verdict,
      lia: {
        purpose: record?.purpose ?? '',
        dataCategories: record?.dataCategories ?? [],
        objectionRoute: record?.objectionRoute ?? '',
      },
    });
    if (!built.ok) {
      outcomes.push(refuse(contactId, 'NOTICE_NOT_BUILDABLE', `${built.code}: ${built.message}`));
      continue;
    }

    if (options.mode === 'PREVIEW') {
      outcomes.push({
        contactId,
        sent: false,
        code: 'SENT',
        message: `Would send: ${built.notice.summary}`,
      });
      continue;
    }

    // ---- past this line the action is irreversible ----------------------------------------
    const dispatch = await actionGateway.dispatchAction({
      actionType: ActionType.PRIVACY_NOTICE_SEND,
      organizationId: orgId,
      targetId: contactId,
      proposedBy: actor,
      payload: {
        contactId,
        to: trimmed(contact.email) ?? '',
        subject: built.notice.subject,
        textBody: built.notice.text,
        htmlBody: built.notice.html,
        // Stable across retries of the same contact and the same assessment, so the §32
        // reconciliation question ("did THIS notice go out?") has an answer. Not derived from
        // a clock: an id that changed per attempt would answer "no" every time and licence the
        // duplicate it exists to prevent.
        idempotencyKey: `a14:${orgId}:${contactId}:${verdict.id}`,
      },
    });

    if (dispatch.success) {
      const providerMessageId =
        typeof dispatch.providerResult?.messageId === 'string' ? dispatch.providerResult.messageId : undefined;
      await runTransaction(store, async (tx) => {
        const fresh = await tx.get(contactRef(orgId, contactId));
        if (!fresh.exists()) return null;
        const current = fresh.data() as Record<string, unknown>;
        tx.set(contactRef(orgId, contactId), {
          ...current,
          article14NoticeSentAt: now.toISOString(),
          article14NoticeEvidence: built.notice.summary,
          article14NoticeRecordedBy: actor,
          article14NoticeMessageId: providerMessageId ?? null,
          // Cleared: the send resolved, so a previous ambiguity is no longer pending.
          article14NoticeAmbiguousAt: null,
          // A notice IS a contact — we put a message in this person's inbox. The frequency cap
          // reads this field and the retention schedule ages from it, so a send that did not
          // write it would leave both reasoning about a person we had in fact just emailed.
          lastContactedAt: now.toISOString(),
          version: (typeof current.version === 'number' ? current.version : 0) + 1,
          updatedAt: now.toISOString(),
        });
        return null;
      });
      outcomes.push({
        contactId,
        sent: true,
        code: 'SENT',
        message: built.notice.summary,
        providerMessageId,
      });
      continue;
    }

    // §32 — the send did not report success. Which kind of not-success decides what is written.
    if (dispatch.requiresReconciliation === true || dispatch.isAmbiguousResult === true) {
      await runTransaction(store, async (tx) => {
        const fresh = await tx.get(contactRef(orgId, contactId));
        if (!fresh.exists()) return null;
        const current = fresh.data() as Record<string, unknown>;
        // `article14NoticeSentAt` is deliberately NOT written here. The contact stays
        // unmailable, which is the failure direction that harms nobody.
        tx.set(contactRef(orgId, contactId), {
          ...current,
          article14NoticeAmbiguousAt: now.toISOString(),
          article14NoticeAmbiguousReason: dispatch.error ?? dispatch.blockedReason ?? 'unknown',
          version: (typeof current.version === 'number' ? current.version : 0) + 1,
          updatedAt: now.toISOString(),
        });
        return null;
      });
      outcomes.push(
        refuse(
          contactId,
          'SEND_AMBIGUOUS',
          `The send neither succeeded nor definitely failed (${dispatch.errorKind ?? 'unknown'}). ` +
            `The notice has NOT been recorded as sent, so this contact remains unmailable — ` +
            `which is the safe direction. Reconcile, or retry with acknowledgesPossibleDuplicate.`
        )
      );
      continue;
    }

    outcomes.push(
      refuse(
        contactId,
        'SEND_FAILED',
        dispatch.blockedReason ?? dispatch.error ?? 'The gateway refused the send without a reason.'
      )
    );
  }

  return { ok: true, mode: options.mode, outcomes };
}
