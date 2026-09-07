import crypto from 'crypto';
import { store } from '../store';
import { orgPath } from '../tenancy/orgScope';
import { doc, getDoc, runTransaction } from '../store';

/**
 * P0.12 — Draft staleness and approval integrity.
 *
 * TWO INVARIANTS, BOTH PREVIOUSLY UNENFORCED
 * ------------------------------------------
 * §8 STALE DRAFT: a draft generated from an older view of a conversation must not be sent
 * after a newer inbound message arrives. The old implementation compared WALL-CLOCK
 * timestamps (`latestInbound.receivedAt > job.createdAt`) against a Postgres table the
 * Firestore write path never populated — so it evaluated zero rows and always passed. Even
 * with data it would have been wrong: §8 explicitly forbids wall-clock as the primary
 * mechanism, because clock skew between writer and reader, and two events inside the same
 * millisecond, both defeat it.
 *
 * §9 APPROVAL INTEGRITY: a human approval must bind to the EXACT content approved. Without a
 * digest, the sequence "human approves draft -> AI regenerates body -> old approval still
 * counts" sends unreviewed content under someone's name.
 *
 * THE MECHANISM
 * -------------
 * Each conversation carries a monotonically increasing `inboundVersion`, incremented inside a
 * transaction as each inbound message is recorded. A draft records the version it was
 * generated from. Immediately before dispatch, the two must be EQUAL — not "close", not
 * "newer than". Any difference means the conversation moved and the draft is stale.
 *
 * The approval digest covers every field that changes what the recipient receives. If any of
 * them is altered after approval, the digest no longer matches and the send is refused.
 */



export interface DraftIntegrityFields {
  generatedForInboundVersion: number;
  approvalDigest: string;
}

function conversationRef(organizationId: string, conversationId: string) {
  if (!store) return null;
  // orgPath validates the id before it becomes a path segment. The org id now travels with
  // the job rather than being a module constant, so it is no longer trusted by construction.
  return doc(store, orgPath(organizationId, 'conversations'), conversationId);
}

/**
 * Atomically increment a conversation's inbound version and return the new value. Called once
 * per recorded inbound message. The transaction is what makes concurrent inbound deliveries
 * safe: two messages arriving together produce two distinct versions rather than both reading
 * the same value and writing the same increment.
 */
export async function incrementInboundVersion(
  organizationId: string,
  conversationId: string
): Promise<number> {
  const ref = conversationRef(organizationId, conversationId);
  if (!ref || !store) {
    throw new Error('Cannot increment inbound version: datastore unavailable.');
  }

  return runTransaction(store, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? Number((snap.data() as any)?.inboundVersion ?? 0) : 0;
    const next = Number.isFinite(current) ? current + 1 : 1;
    // merge:true so this works whether or not the conversation document already exists.
    tx.set(ref, { inboundVersion: next, inboundVersionUpdatedAt: Date.now() }, { merge: true });
    return next;
  });
}

/**
 * Read the current inbound version.
 *
 * FAILS CLOSED: if the version cannot be determined, this throws rather than returning a
 * default. A default of 0 would compare equal to an unstamped draft and wave it through,
 * which is the failure mode this whole mechanism exists to prevent.
 */
export async function getInboundVersion(
  organizationId: string,
  conversationId: string
): Promise<number> {
  const ref = conversationRef(organizationId, conversationId);
  if (!ref) {
    throw new Error('Cannot read inbound version: datastore unavailable.');
  }
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    // A conversation with no document has received nothing, so version 0 is meaningful here
    // (as opposed to "unknown"), and a draft stamped with anything else is stale.
    return 0;
  }
  const raw = (snap.data() as any)?.inboundVersion;
  const version = Number(raw ?? 0);
  if (!Number.isFinite(version) || version < 0) {
    throw new Error(`Conversation ${conversationId} has a malformed inboundVersion: ${JSON.stringify(raw)}`);
  }
  return version;
}

export interface ApprovalDigestInput {
  organizationId: string;
  to: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
  conversationId: string;
  inboundVersion: number;
}

/**
 * Deterministic digest over everything that determines what the recipient receives.
 *
 * Fields are joined with a delimiter that cannot appear in the values (a null byte) so that
 * moving text between adjacent fields changes the digest. Without that, subject "A" + body
 * "B" and subject "AB" + body "" would hash identically, and an attacker (or a bug) could
 * shift content across the boundary while keeping approval valid.
 */
export function computeApprovalDigest(input: ApprovalDigestInput): string {
  const parts = [
    // P1.1 — Bumped to v2 when organizationId entered the digest. The tag is what makes the
    // change legible: a digest computed under a different field set must not silently be
    // compared against one computed under this set, it must fail to match and say why.
    'v2',
    input.organizationId,
    input.conversationId,
    String(input.inboundVersion),
    input.to,
    input.subject,
    input.htmlBody ?? '',
    input.textBody ?? '',
  ];
  return crypto.createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex');
}

export type IntegrityVerdict =
  | { ok: true }
  | { ok: false; code: 'STALE_DRAFT' | 'DIGEST_MISMATCH' | 'UNSTAMPED_DRAFT'; reason: string };

/**
 * The check that runs immediately before dispatch — the last point at which a send can still
 * be stopped.
 */
export async function verifyDraftIntegrity(job: {
  id: string;
  organizationId: string;
  conversationId: string;
  payload: { to: string; subject: string; htmlBody?: string; textBody?: string };
  generatedForInboundVersion?: number;
  approvalDigest?: string;
}): Promise<IntegrityVerdict> {
  // An unstamped draft predates this mechanism, or was produced by a path that bypasses it.
  // Either way its provenance is unknown, so it is refused rather than trusted.
  if (typeof job.generatedForInboundVersion !== 'number') {
    return {
      ok: false,
      code: 'UNSTAMPED_DRAFT',
      reason:
        `Job ${job.id} carries no generatedForInboundVersion, so it cannot be shown to reflect ` +
        `the current conversation. Refusing to send an unverifiable draft.`,
    };
  }

  const currentVersion = await getInboundVersion(job.organizationId, job.conversationId);

  if (currentVersion !== job.generatedForInboundVersion) {
    return {
      ok: false,
      code: 'STALE_DRAFT',
      reason:
        `Conversation ${job.conversationId} is at inbound version ${currentVersion} but this ` +
        `draft was generated for version ${job.generatedForInboundVersion}. A newer inbound ` +
        `message arrived after the draft was written; it must be regenerated, not sent.`,
    };
  }

  if (job.approvalDigest) {
    const expected = computeApprovalDigest({
      organizationId: job.organizationId,
      to: job.payload.to,
      subject: job.payload.subject,
      htmlBody: job.payload.htmlBody,
      textBody: job.payload.textBody,
      conversationId: job.conversationId,
      inboundVersion: job.generatedForInboundVersion,
    });
    if (expected !== job.approvalDigest) {
      return {
        ok: false,
        code: 'DIGEST_MISMATCH',
        reason:
          `Job ${job.id} content no longer matches what was approved. The recipient, subject or ` +
          `body changed after approval, so the approval is void and re-approval is required.`,
      };
    }
  }

  return { ok: true };
}
