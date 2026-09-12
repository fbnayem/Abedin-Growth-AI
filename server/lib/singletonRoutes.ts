import type { Request, Response } from 'express';
import { getDoc, doc, store } from '../store';
import { orgScope, orgPath } from '../tenancy/orgScope';
import { sendError } from './errors';
import { expectedVersionFrom, mutateWithVersion, sendMutationOutcome, sendVersionRequired, versionOf } from './concurrency';
import { mergeSingletonBody } from './singleton';

/**
 * S39 — the two singleton documents (company brain, settings): read, validate, write.
 *
 * Moved out of server.ts on 2026-09-12, text unchanged. Shared by companyBrain.routes.ts and
 * settings.routes.ts, which is why it is a module and not a router.
 */
/**
 * P1.3 — The two singleton documents (company brain, settings).
 *
 * The GET used to read the whole COLLECTION and return `items[0]` — an arbitrary row, since
 * Firestore imposes no order — while the POST wrote the document `main`. So a second
 * document in either collection made the read and the write disagree about which record the
 * operator was looking at. They now both address `main`.
 *
 * The GET also returns `version` and an ETag, because a caller cannot state the version it
 * is updating unless the read gives it one.
 */
export async function readSingleton(req: Request, res: Response, collectionName: string) {
  const ref = doc(store, orgPath(orgScope(req), collectionName), 'main');
  const snap = await getDoc(ref);
  const data: any = snap.exists() ? snap.data() : {};
  const version = versionOf(data, snap.exists());
  res.setHeader('ETag', `"${version}"`);
  return res.json({ ...data, version });
}

export async function writeSingleton(
  req: Request,
  res: Response,
  collectionName: string,
  payload: Record<string, unknown>
) {
  const ref = doc(store, orgPath(orgScope(req), collectionName), 'main');
  const expected = expectedVersionFrom(req);

  if (expected.ok === false) {
    // Tell the caller the current version in the same response that refuses the write, so
    // recovering from the error is one retry rather than a second round trip.
    const snap = await getDoc(ref);
    return sendVersionRequired(req, res, expected, versionOf(snap.exists() ? snap.data() : null, snap.exists()));
  }

  // `version` and `expectedVersion` are transport, not content: they must not be persisted
  // as document fields, or the next read would hand them back as data.
  const { expectedVersion: _ignored, version: _alsoIgnored, ...body } = payload as any;

  // The contract for these two documents says PARTIAL update — "Every field is optional" —
  // and `mutateWithVersion` writes the document WHOLE, deliberately, so that a field removed by
  // `produceNext` is genuinely removed. Both are right; composing the merge here is what makes
  // them true at once. Without it, `POST /api/company-brain` with `{ tagline }` — exactly what
  // the schema invites and what the brain editor sends — replaced the entire brain with one
  // field. See server/lib/singleton.ts.
  const outcome = await mutateWithVersion(ref, expected.value, (current) =>
    mergeSingletonBody(current, body)
  );
  return sendMutationOutcome(req, res, outcome);
}
