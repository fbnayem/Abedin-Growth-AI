/**
 * S28 — THE AUTOMATIC REPLY THAT CARRIES NO HEADERS, AND THE LOOP IT STARTS.
 *
 * WHAT `automatedMail.ts` CANNOT DO
 * --------------------------------
 * That module classifies inbound mail from headers and MIME structure, and refuses to reply to
 * anything carrying an automation marker. It is deliberate that it never looks at subject
 * prose: matching "Out of Office" is the substring-classification defect this repository
 * already carries a guardrail against, and it does not survive a recipient whose autoresponder
 * writes in Portuguese.
 *
 * Which leaves a real gap, and the status document names it: an out-of-office that sets no
 * `Auto-Submitted`, no `X-Autoreply`, no `Precedence`, and does not come from a role address is
 * indistinguishable from a person replying. There is no header to add. The evidence does not
 * exist in the message.
 *
 * WHAT CAN BE DONE INSTEAD
 * ------------------------
 * Bound the conversation. RFC 3834 §2.1 requires an automatic responder to limit how often it
 * responds to the same address, precisely because the marker-based defences it also specifies
 * are not sufficient on their own. Two machines answering each other is the harm; a counter
 * stops it regardless of what either message looked like.
 *
 * So this answers one question — "have we already replied to this conversation enough times,
 * or too recently?" — from timestamps rather than from content. It is language-independent, it
 * cannot be steered by anything a correspondent writes, and it catches the case headers cannot.
 *
 * TWO LIMITS, FOR TWO DIFFERENT FAILURES
 * --------------------------------------
 *   - A CADENCE limit. Two autoresponders ping-ponging generate replies seconds apart. A human
 *     conversation does not need us to answer twice inside a few minutes, and a minimum gap
 *     costs a real correspondent a short wait while costing a loop everything.
 *   - A COUNT limit inside a rolling window. A slower loop — an autoresponder that answers
 *     hourly — defeats the cadence check and is caught by the total.
 *
 * Neither is a substitute for the other: the first bounds the rate, the second bounds the
 * damage.
 */

/**
 * How many autonomous replies one conversation may receive inside the window.
 *
 * Three, not one: a real exchange can legitimately need several turns, and a limit that fires
 * on ordinary correspondence is a limit an operator will raise until it stops firing. It is
 * small enough that a loop is stopped after three messages rather than three hundred.
 */
export const MAX_REPLIES_PER_WINDOW = 3;

/** The rolling window the count is measured over. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The minimum gap between two autonomous replies on one conversation.
 *
 * Ten minutes. A person waiting for an answer notices; a mail loop is stopped dead, because
 * the thing that makes a loop dangerous is its rate rather than its existence.
 */
export const MIN_INTERVAL_MS = 10 * 60 * 1000;

export type ReplyLoopVerdict =
  | { readonly allowed: true; readonly repliesInWindow: number }
  | {
      readonly allowed: false;
      readonly code: 'HISTORY_UNAVAILABLE' | 'TOO_SOON' | 'WINDOW_EXHAUSTED';
      readonly reason: string;
      readonly repliesInWindow: number | null;
    };

/**
 * May we send another autonomous reply on this conversation?
 *
 * `history` is the list of times we previously sent one, in epoch milliseconds, or NULL when it
 * could not be read.
 *
 * THE NULL IS THE POINT. An empty array and an unreadable history are different facts: the
 * first says we have sent nothing, the second says we do not know. `outbox.service.listByStatus`
 * catches its own errors and returns `[]`, which is correct for drawing a console — an empty
 * queue displays as empty — and would be an inversion here, because "the query failed" would
 * become "no replies sent yet" and the send would proceed. That is exactly the shape of the
 * three defects the autonomy lock had. So the caller must hand us a null it cannot fake.
 *
 * Times are passed in rather than read from a clock, so the decision is a pure function of its
 * inputs and a test can hold time still (§30).
 */
export function replyLoopVerdict(input: {
  history: readonly number[] | null;
  now: number;
}): ReplyLoopVerdict {
  const { history, now } = input;

  if (history === null) {
    return {
      allowed: false,
      code: 'HISTORY_UNAVAILABLE',
      reason:
        'Cannot read how many autonomous replies this conversation has already received. ' +
        'Refusing rather than assuming none — an unreadable history is how a mail loop gets ' +
        'its first extra turn.',
      repliesInWindow: null,
    };
  }

  // A non-finite timestamp is not a time. Dropping it silently would shrink the count and
  // permit a send; counting it as recent would refuse every send. Neither is honest, so a
  // history containing one is unusable.
  if (history.some((t) => typeof t !== 'number' || !Number.isFinite(t))) {
    return {
      allowed: false,
      code: 'HISTORY_UNAVAILABLE',
      reason:
        'The reply history contains a value that is not a timestamp, so the count cannot be ' +
        'trusted. Refusing rather than counting around it.',
      repliesInWindow: null,
    };
  }

  // A send stamped in the future is a clock problem, not permission. Kept in the window count
  // rather than discarded: if it is real, it is a reply we made.
  const inWindow = history.filter((t) => now - t < WINDOW_MS);
  const repliesInWindow = inWindow.length;

  const mostRecent = inWindow.length === 0 ? null : Math.max(...inWindow);
  if (mostRecent !== null && now - mostRecent < MIN_INTERVAL_MS) {
    return {
      allowed: false,
      code: 'TOO_SOON',
      reason:
        `An autonomous reply was sent on this conversation ${Math.max(0, Math.round((now - mostRecent) / 1000))}s ` +
        `ago, inside the ${Math.round(MIN_INTERVAL_MS / 60000)}-minute minimum interval. Two ` +
        'autoresponders answering each other look exactly like this, and no header on either ' +
        'message would say so.',
      repliesInWindow,
    };
  }

  if (repliesInWindow >= MAX_REPLIES_PER_WINDOW) {
    return {
      allowed: false,
      code: 'WINDOW_EXHAUSTED',
      reason:
        `${repliesInWindow} autonomous replies have already been sent on this conversation in ` +
        `the last ${Math.round(WINDOW_MS / 3600000)} hours (limit ${MAX_REPLIES_PER_WINDOW}). ` +
        'A slow loop defeats the minimum-interval check and is caught here.',
      repliesInWindow,
    };
  }

  return { allowed: true, repliesInWindow };
}
