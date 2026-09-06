import { db } from '../db/index';
import { oauthConnections, messages } from '../db/schema';
import { eq, and } from 'drizzle-orm';
import { gmailService } from './gmail.service';
import { inboundPipeline } from './inboundPipeline';

export class GmailHistorySyncService {
  // N. GMAIL EDGE CASES
  async handleHistoryExpiration(emailAddress: string) {
      console.warn(`[GmailHistorySync] History ID expired for ${emailAddress}. Performing full sync.`);
      // Logic for full sync goes here
  }

  async processEvent(emailAddress: string, historyId: string) {
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
      
      for (const item of historyItems) {
         if (item.messagesAdded) {
           for (const msgAdded of item.messagesAdded) {
             const messageId = msgAdded.message.id;
             
             // Deduplication: check if we already have it
             const existingMsg = await db.select().from(messages).where(eq(messages.providerMessageId, messageId)).limit(1);
             if (existingMsg.length > 0) {
                console.log(`Message ${messageId} already exists. Skipping.`);
                continue;
             }
             
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
    } catch(e: any) {
      if (e.message?.includes('historyId is out of date') || e.code === 404) {
         await this.handleHistoryExpiration(emailAddress);
      } else {
         console.error("Error syncing Gmail history:", e);
      }
    }
  }
}

export const gmailHistorySyncService = new GmailHistorySyncService();
