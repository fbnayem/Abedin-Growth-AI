import type { Request, Response } from 'express';
import { runTransaction, type DocumentReference } from 'firebase/firestore';
import { firestore } from '../firebase';

/**
 * P1.3 — OPTIMISTIC CONCURRENCY.
 *
 * WHAT WAS WRONG
 * --------------
 * Every mutable document was written blind. Three shapes of the same bug:
 *
 *   1. WHOLE-DOCUMENT OVERWRITE. `POST /api/settings` and `POST /api/company-brain` were
 *      `setDoc(ref, req.body)` — the entire document replaced by whatever arrived, with no
 *      reference to what was there. Two operators editing the company brain in two tabs: the
 *      second save silently destroys the first, and neither is told. Worse, the company brain
 *      is stringified into every outbound prompt, so a lost update is not a lost form field —
 *      it is the wrong pricing or the wrong claim in mail sent to customers.
 *
 *   2. READ-MODIFY-WRITE. `POST /api/campaigns/:id/toggle` read the status, negated it, and
 *      wrote it back in a separate call. Two clicks in the same second read the same value and
 *      both write the same negation, so a campaign an operator meant to stop stays running.
 *      A toggle cannot express intent at all: the request does not say what the operator
 *      wanted, only "the other one".
 *
 *   3. WRITE WITHOUT READ. `POST /api/pipeline/:id/stage` wrote the stage with no idea what it
 *      was replacing.
 *
 * None of these is detectable after the fact. There is no version, so there is no evidence a
 * write was lost, and nothing to reconcile against.
 *
 * THE MECHANISM
 * -------------
 * Every mutable document carries `version`, an integer that increments on each write. A
 * mutation states the version it believes it is updating; the comparison and the write happen
 * inside one Firestore transaction, so nothing can interleave between them. A mismatch is a
 * 409 carrying the current version, which is enough for a client to re-read, re-apply and
 * retry.
 *
 * A MISSING EXPECTED VERSION IS REFUSED, NOT ASSUMED (§14). "The caller did not say" is not
 * "the caller means whatever is there now" — that reading is precisely what produced the lost
 * updates above. It answers 428 Precondition Required, and includes the current version so the
 * first thing a caller does with the error is the thing that fixes it.
 *
 * Version 0 means "this document does not exist yet", so a create is expressed as
 * `expectedVersion: 0` and races between two creates resolve the same way as any other
 * conflict, rather than one silently overwriting the other.
 */

export const VERSION_FIELD = 'version';

export interface VersionedSnapshot<T = Record<string, unknown>> {
  exists: boolean;
  version: number;
  data: T | null;
}

export type MutationOutcome<T = Record<string, unknown>> =
  | { ok: true; version: number; data: T }
  | { ok: false; code: 'VERSION_CONFLICT'; currentVersion: number; message: string }
  | { ok: false; code: 'NOT_FOUND'; currentVersion: 0; message: string }
  | { ok: false; code: 'STORE_UNAVAILABLE'; message: string };

/**
 * Read the version off a document snapshot.
 *
 * An absent document is version 0. A document that exists but has no `version` field is ALSO
 * treated as 0 — it predates this mechanism, so the caller must acknowledge it explicitly with
 * `expectedVersion: 0` rather than having its unknown provenance waved through.
 *
 * A malformed version throws. Coercing it would make the comparison meaningless in exactly the
 * situation where something has already gone wrong with the document.
 */
export function versionOf(data: unknown, exists: boolean): number {
  if (!exists || data === null || typeof data !== 'object') return 0;
  const raw = (data as Record<string, unknown>)[VERSION_FIELD];
  if (raw === undefined || raw === null) return 0;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`Document has a malformed ${VERSION_FIELD}: ${JSON.stringify(raw)}`);
  }
  return version;
}

export type ExpectedVersion =
  | { ok: true; value: number }
  | { ok: false; code: 'VERSION_REQUIRED' | 'VERSION_MALFORMED'; message: string };

/**
 * The version the caller believes it is updating.
 *
 * Accepted as an `If-Match` header (bare, or the quoted/weak ETag forms a browser will send
 * back verbatim from a previous response) or as `expectedVersion` in the body. The header is
 * preferred because it survives being proxied and does not collide with document content.
 */
export function expectedVersionFrom(req: Request): ExpectedVersion {
  const header = req.headers['if-match'];
  const raw =
    typeof header === 'string'
      ? header.trim().replace(/^W\//i, '').replace(/^"(.*)"$/, '$1')
      : (req.body as any)?.expectedVersion;

  if (raw === undefined || raw === null || raw === '') {
    return {
      ok: false,
      code: 'VERSION_REQUIRED',
      message:
        'This write must state the version it is updating. Send If-Match with the version ' +
        'from your last read (0 to create). Writing without one silently discards a ' +
        'concurrent edit.',
    };
  }

  // '*' is the HTTP wildcard for "any current representation". It is deliberately NOT
  // supported: it means "overwrite whatever is there", which is the behaviour being removed.
  if (raw === '*') {
    return {
      ok: false,
      code: 'VERSION_MALFORMED',
      message: 'If-Match: * is not accepted here. State the version you read.',
    };
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return {
      ok: false,
      code: 'VERSION_MALFORMED',
      message: `Expected version must be a non-negative integer; received ${JSON.stringify(raw)}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Apply a mutation under an expected version, inside a transaction.
 *
 * `produceNext` receives the CURRENT document (null when it does not exist) and returns the
 * fields to write. It runs inside the transaction and may be retried, so it must be a pure
 * function of its input — no side effects, no external reads.
 *
 * The stored document is `{ ...produceNext(current), version: current + 1, updatedAt }`. The
 * version is applied by this function and cannot be set by the caller's payload, so a client
 * cannot pin or rewind it by including `version` in a request body.
 */
export async function mutateWithVersion<T extends Record<string, unknown>>(
  ref: DocumentReference,
  expectedVersion: number,
  produceNext: (current: T | null) => T,
  options: { requireExisting?: boolean } = {}
): Promise<MutationOutcome<T>> {
  if (!firestore) {
    return { ok: false, code: 'STORE_UNAVAILABLE', message: 'Datastore unavailable.' };
  }

  try {
    return await runTransaction(firestore, async (tx) => {
      const snap = await tx.get(ref);
      const exists = snap.exists();
      const current = exists ? (snap.data() as T) : null;
      const currentVersion = versionOf(current, exists);

      if (options.requireExisting && !exists) {
        return {
          ok: false as const,
          code: 'NOT_FOUND' as const,
          currentVersion: 0 as const,
          message: 'No such document.',
        };
      }

      if (currentVersion !== expectedVersion) {
        return {
          ok: false as const,
          code: 'VERSION_CONFLICT' as const,
          currentVersion,
          message:
            `This document is at version ${currentVersion}; the write was made against ` +
            `version ${expectedVersion}. Someone else changed it. Re-read, re-apply your ` +
            `change, and retry — do not resend as-is.`,
        };
      }

      const next = produceNext(current);
      const nextVersion = currentVersion + 1;

      // Written whole, so a field removed by produceNext is genuinely removed. The version and
      // timestamp are stamped last so a payload carrying its own `version` cannot win.
      //
      // `updatedAt` is an ISO STRING, not an epoch number, because the domain declares it as
      // `updatedAt: string` (shared/domain/models.ts) and the UI renders it as one. Writing a
      // number here would type-check — everything through Firestore is `any` — and then render
      // as a bare millisecond count in the interface.
      tx.set(ref, { ...next, [VERSION_FIELD]: nextVersion, updatedAt: new Date().toISOString() });

      return { ok: true as const, version: nextVersion, data: next };
    });
  } catch (e: any) {
    // A transaction abort means someone else committed first. Report it as the conflict it is
    // rather than a server fault, so the client retries instead of paging someone.
    console.warn('[concurrency] Transaction failed:', e?.message);
    return {
      ok: false,
      code: 'VERSION_CONFLICT',
      currentVersion: -1,
      message: `The document changed during this write (${e?.message ?? 'transaction aborted'}). Re-read and retry.`,
    };
  }
}

/**
 * Translate an outcome into an HTTP response. One place, so every endpoint answers the same
 * way and a client can branch on `error.code` rather than on prose.
 */
export function sendMutationOutcome(res: Response, outcome: MutationOutcome): Response {
  // Written as `=== false` first, deliberately. `if (outcome.ok)` does not narrow the negative
  // branch of this union for TypeScript, and the failure mode is that the error cases silently
  // stop being type-checked.
  if (outcome.ok === false) {
    switch (outcome.code) {
      case 'VERSION_CONFLICT':
        // 409 with the current version: the error carries what the caller needs to recover.
        if (outcome.currentVersion >= 0) res.setHeader('ETag', `"${outcome.currentVersion}"`);
        return res.status(409).json({
          error: {
            code: 'VERSION_CONFLICT',
            message: outcome.message,
            details: { currentVersion: outcome.currentVersion },
          },
        });
      case 'NOT_FOUND':
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: outcome.message } });
      case 'STORE_UNAVAILABLE':
        return res
          .status(503)
          .json({ error: { code: 'STORE_UNAVAILABLE', message: outcome.message } });
    }
  }

  res.setHeader('ETag', `"${outcome.version}"`);
  return res.json({ ...outcome.data, version: outcome.version });
}

/** Refusal for a write that did not state a version. 428, with the current version attached. */
export function sendVersionRequired(
  res: Response,
  problem: Extract<ExpectedVersion, { ok: false }>,
  currentVersion: number | null
): Response {
  if (currentVersion !== null) res.setHeader('ETag', `"${currentVersion}"`);
  return res.status(428).json({
    error: {
      code: problem.code,
      message: problem.message,
      details: currentVersion === null ? undefined : { currentVersion },
    },
  });
}
