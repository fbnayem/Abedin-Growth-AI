import { db } from '../db/index';
import { oauthConnections, messages } from '../db/schema';
import { eq } from 'drizzle-orm';
import { gmailService, isValidHistoryId } from './gmail.service';
import { inboundPipeline } from './inboundPipeline';
import { classifyThrown } from '../lib/providerError';

/**
 * S19 / P0.5 — the loop an anonymous caller can drive.
 *
 * `/api/webhooks/gmail` is auth-exempt (the bypass is a `req.path.includes('/webhook')`
 * SUBSTRING test) and signature-unverified, and it calls straight into here. Two things were
 * wrong with that arrangement beyond the webhook itself:
 *
 *   1. `historyId` went unvalidated into a request URL. Fixed in the adapter: it must be an
 *      unsigned decimal or the request is refused.
 *   2. THE LOOP WAS UNCAPPED. Every message in the history page called the full AI pipeline —
 *      several model calls each — with nothing bounding how many messages one notification
 *      could claim to carry. That is an unauthenticated financial-loss primitive: the cost of
 *      one request to us is set by the party making it.
 *
 * The cap is per notification, and reaching it is reported rather than silently truncating.
 * Gmail re-delivers unacknowledged history, so a page larger than the cap is not lost — it is
 * deferred, which is the correct behaviour for a queue we do not control.
 */
export const MAX_MESSAGES_PER_NOTIFICATION = 25;

export class GmailHistorySyncService {
  /**
   * Gmail expires history ids after roughly a week and answers 404 for one that has aged out.
   * The documented recovery is a full synchronisation from a fresh `historyId`.
   *
   * This method does not do that. It says so, loudly, instead of logging a reassuring line: a
   * "Performing full sync." message above an empty body is a fabricated success in the same
   * family as the endpoints P1.13 exists to retire, and an operator reading the log would
   * reasonably believe the mailbox had resynchronised.
   */
  async handleHistoryExpiration(emailAddress: string): Promise<void> {
    console.error(
      `[GmailHistorySync] NOT IMPLEMENTED: the history cursor for ${emailAddress} has expired ` +
        'and a full mailbox synchronisation is required. This has NOT been performed. Every ' +
        'message that arrived while the cursor was stale is unread by this system until a full ' +
        'sync is implemented or the connection is re-established.'
    );
  }

  async processEvent(emailAddress: string, historyId: string): Promise<void> {
    // Refused at the boundary as well as in the adapter. The adapter's check protects the
    // request it builds; this one keeps an unauthenticated caller from reaching the datastore
    // read below with a value we have already decided is not a history id.
    if (!isValidHistoryId(historyId)) {
      console.warn(
        `[GmailHistorySync] Refusing a notification for ${emailAddress}: historyId ` +
          `${JSON.stringify(historyId)} is not an unsigned decimal id.`
      );
      return;
    }

    try {
      // Find the oauth connection
      const oauths = await db.select().from(oauthConnections).where(eq(oauthConnections.accountEmail, emailAddress));
      const gmailAuth = oauths.find(o => o.provider === 'GMAIL');

      if (!gmailAuth || !gmailAuth.accessToken) {
         console.error("No valid OAuth connection for email:", emailAddress);
         return;
      }

      gmailService.setCredentials({ access_token: gmailAuth.accessToken });

      const historyItems = await gmailService.getHistory(historyId, emailAddress);

      let processed = 0;
      let deferred = 0;

      for (const item of historyItems) {
         if (item.messagesAdded) {
           for (const msgAdded of item.messagesAdded) {
             // P0.5 — the cap. Counted BEFORE the datastore read and the model calls, so a
             // notification claiming a thousand messages costs us twenty-five.
             if (processed >= MAX_MESSAGES_PER_NOTIFICATION) {
               deferred++;
               continue;
             }

             const messageId = msgAdded.message.id;

             // Deduplication: check if we already have it
             const existingMsg = await db.select().from(messages).where(eq(messages.providerMessageId, messageId)).limit(1);
             if (existingMsg.length > 0) {
                console.log(`Message ${messageId} already exists. Skipping.`);
                continue;
             }

             processed++;
             const fullMessage = await gmailService.getMessage(messageId);
             if (fullMessage) {
               console.log("Fetched full message", fullMessage.id);
               // Pass to unified inbound pipeline.
               //
               // The result is READ. It used to return `void`, so this await could not tell a
               // deliberate suppression from a TypeError thrown on line 400 — both resolved
               // normally and the sync continued as though the message had been handled.
               const outcome = await inboundPipeline.processNewEmail(
                 fullMessage,
                 gmailAuth.organizationId
               );
               // `outcome.ok === false` rather than `!outcome.ok`: without `strict`, TypeScript
               // does not narrow a discriminated union through the negative arm of a truthiness
               // test, and the `as any` that would silence it is the habit this branch is
               // removing everywhere else.
               if (outcome.ok === false) {
                 // Not rethrown: one unprocessable message must not abandon the rest of the
                 // history page. But it is named, with the stage it stopped at, so a run that
                 // dropped messages does not look identical to one that did not.
                 console.error(
                   `[GmailHistorySync] message ${fullMessage.id} was NOT processed ` +
                     `(${outcome.stage}): ${outcome.detail}`
                 );
               } else {
                 console.log(
                   `[GmailHistorySync] message ${fullMessage.id}: ${outcome.disposition} — ${outcome.detail}`
                 );
               }
             }
           }
         }
      }

      if (deferred > 0) {
        // Silent truncation reads as "we handled everything". Gmail re-delivers history that
        // has not been acknowledged, so these are deferred rather than lost — but only saying
        // so makes that recoverable rather than a hope.
        console.warn(
          `[GmailHistorySync] ${emailAddress}: processed ${processed} message(s) and DEFERRED ` +
            `${deferred} — the per-notification cap is ${MAX_MESSAGES_PER_NOTIFICATION}. ` +
            'Gmail re-delivers unacknowledged history, so the remainder arrives on a later ' +
            'notification rather than being dropped.'
        );
      }
    } catch(e: any) {
      // Was: `e.message?.includes('historyId is out of date') || e.code === 404`.
      //
      // A substring test on an error message, which is the pattern `providerError.ts` exists to
      // eliminate and which this repository has a guardrail against — this file was its one
      // documented exception. The exception was justified on the grounds that a 404 is
      // "ambiguous between an expired cursor and a deleted mailbox". It is, and that ambiguity
      // does not matter: the response to both is a full resynchronisation, and attempting one
      // against a mailbox that is gone fails cleanly. The exception is retired.
      const classified = classifyThrown(e, { provider: 'gmail', operation: 'getHistory' });
      if (classified.kind === 'NOT_FOUND') {
         await this.handleHistoryExpiration(emailAddress);
      } else {
         console.error(
           `[GmailHistorySync] ${classified.kind} syncing history for ${emailAddress}: ` +
             `${classified.signal}`,
           classified.toLogRecord()
         );
      }
    }
  }
}

export const gmailHistorySyncService = new GmailHistorySyncService();
