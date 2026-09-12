import { Router, type Request, type Response } from 'express';
import { verifyDocuSignSignature, verifyPubSubToken } from '../services/webhookVerification.service';
import { getDoc, doc, updateDoc, store } from '../store';
import { orgPath, isValidOrgId } from '../tenancy/orgScope';
import { assertTransition, MEETING } from '../domain/stateMachines';
import { sendError } from '../lib/errors';
import { stringField } from '../lib/fields';
import { gmailHistorySyncService } from '../services/gmailHistorySync.service';

/**
 * S39 — Inbound webhooks: DocuSign and Gmail Pub/Sub. Unauthenticated; each verifies its caller first.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged; mounted there at `/api`.
 */
export const webhooksRouter = Router();

  // P0.14 — These webhook routes were previously registered ONLY inside the
  // `else` (production) branch below, alongside the static-file handler. In development
  // NODE_ENV !== "production", so neither route existed and both returned 404 — meaning the
  // signature-verification path could never be exercised before shipping. They are
  // registered unconditionally here, ahead of the environment split.
// eSignature routes (DocuSign/PandaDoc Webhook)
webhooksRouter.post('/signature/webhook', async (req: Request, res: Response) => {
  // P0.14 — Verify BEFORE parsing or acting. This handler previously carried the comment
  // "In a real app we verify the HMAC signature from DocuSign here" and did not, which meant
  // anyone who could reach the URL could mark any meeting CONFIRMED by posting a JSON body.
  const verification = verifyDocuSignSignature(req, req.body as unknown as Buffer);
  if (!verification.ok) {
    console.warn(`[signature/webhook] Rejected unverified webhook: ${verification.reason}`);
    return sendError(req, res, 'WEBHOOK_VERIFICATION_FAILED', verification.reason);
  }

  try {
    const event = JSON.parse((req.body as unknown as Buffer).toString('utf8'));

    if (event.event === 'envelope-completed') {
      const customField = event.data?.envelopeSummary?.customFields?.customField;
      const meetingId = customField?.find((f: any) => f.name === 'meetingId')?.value;

      // P1.1 — A webhook has no authenticated user, so it cannot use orgScope(req). The
      // organisation must arrive with the envelope, as a custom field we set when the
      // envelope was created. An event that does not carry one is NOT applied to a default
      // tenant: without it we do not know whose meeting this is, and guessing would mean
      // writing one customer's signature confirmation into another customer's records.
      //
      // The value is validated before it reaches a datastore path — it is attacker-adjacent
      // input, since it only got here by surviving signature verification of a body we did
      // not write.
      const envelopeOrgId = customField?.find((f: any) => f.name === 'organizationId')?.value;

      if (meetingId && !isValidOrgId(envelopeOrgId)) {
        console.warn(
          `[signature/webhook] Envelope for meeting ${meetingId} carries no valid ` +
          `organizationId custom field; refusing to guess a tenant. Event ignored.`
        );
      } else if (meetingId) {
        console.log(`DocuSign webhook verified for meeting: ${meetingId}`);

        // P0.14 — Gate the transition on current state instead of writing CONFIRMED
        // unconditionally. Webhook delivery is duplicated, delayed and out of order, so a
        // late replay must not resurrect a meeting that has since been cancelled.
        const meetingRef = doc(store, orgPath(envelopeOrgId, 'meetings'), meetingId);
        const snap = await getDoc(meetingRef);
        if (!snap.exists()) {
          console.warn(`[signature/webhook] Meeting ${meetingId} not found; ignoring event.`);
        } else {
          // P1.4 — The hand-rolled terminal list that used to live here has been replaced by
          // the shared transition map. The rule is the same; the difference is that it is now
          // the same rule every other handler uses, instead of one someone remembered to write
          // here and nowhere else.
          const current = stringField(snap.data(), 'status');
          const verdict = assertTransition(MEETING, current, 'CONFIRMED');
          if (verdict.ok === false) {
            console.warn(
              `[signature/webhook] Ignoring envelope-completed for meeting ${meetingId}: ` +
              `${verdict.message} A late or replayed event must not roll state backward.`
            );
          } else if (verdict.changed === false) {
            console.log(`[signature/webhook] Meeting ${meetingId} is already CONFIRMED; nothing to do.`);
          } else {
            await updateDoc(meetingRef, { status: 'CONFIRMED', statusChangedAt: new Date().toISOString() });
          }
        }
      }
    }
    res.status(200).send("OK");
  } catch(e) {
    console.error("DocuSign webhook error", e);
    sendError(req, res, 'INTERNAL_ERROR', 'The webhook could not be processed.', { cause: e });
  }
});

// Gmail Pub/Sub Webhook
webhooksRouter.post('/webhooks/gmail', async (req: Request, res: Response) => {
  // P0.14 / P0.5 — Verify before doing any work. This endpoint is auth-exempt and drives
  // gmailHistorySyncService.processEvent, an uncapped loop that issues paid AI calls. Left
  // unverified it is an open financial-loss primitive reachable by anyone on the internet.
  const verification = verifyPubSubToken(req);
  if (!verification.ok) {
    console.warn(`[webhooks/gmail] Rejected unverified push: ${verification.reason}`);
    return sendError(req, res, 'WEBHOOK_VERIFICATION_FAILED', verification.reason);
  }

  try {
    const message = req.body.message;
    if (!message || !message.data) {
      return res.status(400).send("Bad Request");
    }

    const decodedData = Buffer.from(message.data, 'base64').toString('utf8');
    const event = JSON.parse(decodedData);


    console.log(`Received Gmail Pub/Sub event for ${event.emailAddress} (historyId: ${event.historyId})`);

    gmailHistorySyncService.processEvent(event.emailAddress, event.historyId)
      .catch((e: Error) => console.error("Error processing history event:", e));

    res.status(200).send("OK");

  } catch(e) {
    console.error("Gmail webhook error", e);
    res.status(500).send("Error");
  }
});
