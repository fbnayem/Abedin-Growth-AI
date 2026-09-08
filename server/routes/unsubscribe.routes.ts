import { Router } from 'express';
import { sendCaught, sendError } from '../lib/errors';
import { recordUnsubscribe } from '../services/unsubscribe.service';

/**
 * S26 — THE ENDPOINT THE `List-Unsubscribe` HEADER POINTS AT.
 *
 * UNAUTHENTICATED BY NECESSITY, AND WHAT STANDS IN FOR AUTHENTICATION
 * -------------------------------------------------------------------
 * The caller is either a recipient's mail client or the recipient's mail PROVIDER acting on
 * their behalf. Neither holds a credential for this system. The token in the path is the whole
 * authorisation: an HMAC over the tenant and contact, verified with `timingSafeEqual` before
 * its payload is parsed. `server/domain/unsubscribe.ts` carries that reasoning.
 *
 * It is in `UNAUTHENTICATED_API_PATTERNS` in `server.ts`, not in the exact-path allowlist,
 * because the path carries the token. That entry is an ANCHORED regex whose character class
 * excludes `/`, which is what separates it from the `req.path.includes('/webhook')` substring
 * test P0.4 removed — that one matched any path containing the word anywhere.
 *
 * GET DOES NOT UNSUBSCRIBE. THAT IS THE POINT OF RFC 8058.
 * -------------------------------------------------------
 * Mail clients, security appliances and link scanners fetch every URL in a message before a
 * human sees it. A GET that changed state would unsubscribe people who never clicked, and the
 * sender would never know: the recipient simply stops hearing from them. So GET serves a
 * confirmation form and only POST writes.
 *
 * The one-click POST comes from the provider and needs no confirmation — that is what
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` promises, and honouring it is the
 * difference between an opt-out that works from the inbox and one that does not.
 *
 * THE CONFIRMATION PAGE INTERPOLATES NOTHING
 * ------------------------------------------
 * Its form posts to `action=""` — the current URL, token included — so no attacker-controlled
 * value is ever concatenated into HTML. The token arrives in the path and is echoed nowhere.
 * That is a smaller surface than escaping it correctly would be, and it cannot regress.
 */
export const unsubscribeRouter = Router();

/**
 * Served for GET, and after a confirmed form POST.
 *
 * A template literal with two fixed substitutions — `heading` and `message` — both of which
 * are string constants defined in this file. Nothing from the request reaches it. The test
 * suite asserts that property directly, because "we do not interpolate here" is the kind of
 * claim that stops being true one convenience at a time.
 */
function page(heading: string, message: string, showForm: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Unsubscribe</title>
</head>
<body style="font-family: system-ui, -apple-system, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem; color: #0f172a; line-height: 1.6;">
<h1 style="font-size: 1.25rem; margin-bottom: 0.5rem;">${heading}</h1>
<p style="color: #475569;">${message}</p>
${
  showForm
    ? `<form method="post" action="?confirmed=1" style="margin-top: 1.5rem;">
<button type="submit" style="background: #0f172a; color: #fff; border: 0; border-radius: 0.5rem; padding: 0.7rem 1.1rem; font-size: 0.95rem; cursor: pointer;">Unsubscribe me</button>
</form>`
    : ''
}
</body>
</html>`;
}

const CONFIRM_HEADING = 'Unsubscribe from these emails?';
const CONFIRM_BODY =
  'Press the button below and we will stop sending to this address. Nothing has changed yet — ' +
  'this page does not act on its own, so that a link scanner opening it cannot unsubscribe you.';

const DONE_HEADING = 'You have been unsubscribed';
const DONE_BODY =
  'This address will not receive further emails from us. If it happens anyway, reply to any ' +
  'message and say so.';

const FAILED_HEADING = 'This did not work';

/**
 * The confirmation page. Deliberately does not verify the token first.
 *
 * Telling an anonymous caller whether a token is valid before they have done anything makes
 * this an oracle for guessing them. The verification happens on POST, where it decides
 * something.
 */
unsubscribeRouter.get('/:token', (_req, res) => {
  res.type('html').send(page(CONFIRM_HEADING, CONFIRM_BODY, true));
});

unsubscribeRouter.post('/:token', async (req, res) => {
  try {
    // The human path arrives as `?confirmed=1` from the form above; a provider's one-click POST
    // does not. Both record an unsubscribe — the distinction exists only so the audit record
    // says which, since RFC 8058 one-click and a person pressing a button are different
    // evidence about intent.
    const confirmed = req.query.confirmed === '1';

    const result = await recordUnsubscribe({
      token: req.params.token,
      at: new Date().toISOString(),
      source: confirmed ? 'CONFIRMED_FORM' : 'ONE_CLICK',
    });

    if (result.ok === false) {
      // A browser gets a page; a provider gets the error envelope. Neither is told which half
      // of a bad token was wrong.
      if (confirmed) {
        return res.status(result.code === 'STORE_UNAVAILABLE' ? 503 : 400)
          .type('html')
          .send(page(FAILED_HEADING, result.message, false));
      }
      return sendError(req, res, result.code === 'STORE_UNAVAILABLE' ? 'STORE_UNAVAILABLE' : 'VALIDATION_ERROR', result.message);
    }

    if (confirmed) {
      return res.type('html').send(page(DONE_HEADING, DONE_BODY, false));
    }
    // RFC 8058: a 2xx is the signal the provider acts on. The body is not shown to anybody.
    return res.status(200).json({ unsubscribed: true });
  } catch (e) {
    return sendCaught(req, res, e);
  }
});
