import { store as defaultStore, doc, setDoc, type DocumentStore } from '../store';
import { orgPath } from '../tenancy/orgScope';
import {
  identityFromToken,
  unsubscribeConfig,
  type UnsubscribeIdentity,
} from '../domain/unsubscribe';

/**
 * RECORDING AN UNSUBSCRIBE — separated from the route, because a route cannot be tested.
 *
 * The pattern is established at this point: `autonomyLock.service.ts` exists because two
 * mutations of an express handler survived the whole gate, and the batch read moved out of a
 * handler for the same reason one commit ago. Everything below takes its inputs and returns
 * its result, so `unsubscribe.invariant.test.ts` can call it.
 *
 * WHAT IT WRITES, AND WHY IT MERGES
 * ---------------------------------
 * `unsubscribed: true` is the field `actionGateway.ts:645` already refuses on. This is the
 * writer that check never had.
 *
 * The write MERGES, and a merging set in `server/store/index.ts` CREATES when the document is
 * absent. That is deliberate and is the single most important property here: an unsubscribe
 * for a contact record that has been deleted, or that never existed, still lands. The
 * alternative — requiring the contact to exist — discards the one signal a recipient is
 * legally and practically entitled to have honoured, in exactly the case where the system's
 * own bookkeeping is already wrong.
 */

export type UnsubscribeResult =
  | { readonly ok: true; readonly identity: UnsubscribeIdentity }
  | {
      readonly ok: false;
      readonly code: 'NOT_CONFIGURED' | 'INVALID_TOKEN' | 'STORE_UNAVAILABLE';
      readonly message: string;
    };

/**
 * The message shown for an unusable token.
 *
 * ONE MESSAGE FOR EVERY WAY A TOKEN CAN FAIL. "Signature does not verify", "unrecognised
 * version" and "payload does not name a usable contact" are useful in a log and are an oracle
 * in a response body: they tell someone probing the endpoint which half of their guess was
 * wrong. The specific reason is logged; the caller gets one sentence.
 */
const BAD_TOKEN =
  'This unsubscribe link is not valid. It may have been altered in transit, or truncated by ' +
  'a mail client. Reply to the message and ask to be removed, and that will be honoured.';

const NOT_CONFIGURED =
  'Unsubscribe handling is not configured on this deployment, so this link cannot be ' +
  'verified. No mail carrying an unsubscribe header is sent while this is true.';

export async function recordUnsubscribe(input: {
  token: unknown;
  at: string;
  source: 'ONE_CLICK' | 'CONFIRMED_FORM';
  env?: NodeJS.ProcessEnv;
  store?: DocumentStore | null;
}): Promise<UnsubscribeResult> {
  const config = unsubscribeConfig(input.env ?? process.env);
  if (config === null) {
    return { ok: false, code: 'NOT_CONFIGURED', message: NOT_CONFIGURED };
  }

  const parsed = identityFromToken(input.token, config);
  if (parsed.ok === false) {
    console.warn(`[unsubscribe] Refused a token: ${parsed.reason}`);
    return { ok: false, code: 'INVALID_TOKEN', message: BAD_TOKEN };
  }

  const store = input.store === undefined ? defaultStore : input.store;
  if (!store) {
    // NOT reported as success. A recipient told "you have been unsubscribed" when nothing was
    // written will not press it again, and the next campaign reaches them anyway.
    return {
      ok: false,
      code: 'STORE_UNAVAILABLE',
      message:
        'The unsubscribe could not be recorded because the datastore is unavailable. It has ' +
        'NOT been applied — please try again shortly.',
    };
  }

  const { orgId, contactId } = parsed.identity;
  await setDoc(
    doc(store, orgPath(orgId, 'contacts'), contactId),
    {
      unsubscribed: true,
      unsubscribedAt: input.at,
      unsubscribeSource: input.source,
    },
    { merge: true }
  );

  return { ok: true, identity: parsed.identity };
}
