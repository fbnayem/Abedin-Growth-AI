import { Router } from 'express';
import { orgScope } from '../tenancy/orgScope';
import { sendError, sendCaught } from '../lib/errors';
import { operatorGate, type Attribution } from '../domain/operatorAction';
import { isProduction } from '../config/environment';
import { readLock, readLocksFor, changeLock } from '../services/autonomyLock.service';

/**
 * THE WRITER THE AUTONOMY LOCK NEVER HAD.
 *
 * `actionGateway.checkHumanOwnershipLock` and `outbox.worker` both refuse to dispatch when
 * `autonomyPausedByHuman` is set on a conversation. Both are careful, both carry comments
 * explaining how they honour it — and until this router existed, nothing in the running system
 * could set it. The only writer was `aiSafetyService.setHumanOwnershipLock`, and that service
 * had no callers anywhere: the worker imported it and never used it.
 *
 * So a human watching the system draft the wrong thing to a customer had no way to stop it for
 * that customer. There was a kill switch for the whole organisation and nothing between that
 * and letting it send. The enforcement made the control look present, which is worse than its
 * absence.
 *
 * WHY THIS IS NOT THE CIRCUIT BREAKER
 * -----------------------------------
 * The circuit breaker stops everything for a tenant; this stops one conversation. An operator
 * who has to halt the entire outbound queue in order to take over one thread will not do it,
 * and will let the send go.
 *
 * THIS FILE IS DELIBERATELY THIN, and that is not a style preference. The decisions live in
 * `services/autonomyLock.service.ts`, where a test can call them without constructing a
 * request. While they were inline here, two mutations of them survived the entire gate —
 * reporting a state that had not been written, and dropping the attribution check — because
 * nothing exercised the handler.
 */
export const autonomyRouter = Router();

function attributedOrRefused(req: any, res: any): Attribution | null {
  const gate = operatorGate(req.user, isProduction);
  if (gate.allowed === false) {
    sendError(req, res, 'ATTRIBUTION_REQUIRED', gate.message);
    return null;
  }
  return gate.attribution;
}

/**
 * The locks for a named set of conversations — what the outbox console draws its badges from.
 *
 * `GET /api/autonomy?conversationIds=a,b,c`
 *
 * Registered before `/:conversationId` for reading order only; Express cannot confuse them,
 * because `/:conversationId` requires a path segment and this route is the bare root.
 *
 * A CONVERSATION MISSING FROM THE RESPONSE IS NOT AN ERROR AND IS NOT PERMISSION. The console
 * reads an absent conversation as UNKNOWN and refuses on it, so a datastore that answers for
 * four of five rows still shows the operator four real states and one honest gap.
 */
autonomyRouter.get('/', async (req, res) => {
  try {
    const result = await readLocksFor(orgScope(req), req.query.conversationIds);
    if (result.ok === false) {
      return sendError(req, res, result.code, result.message);
    }
    return res.json({ locks: result.locks });
  } catch (e) {
    return sendCaught(req, res, e);
  }
});

/**
 * The current lock, as one of three states rather than a boolean, because the caller needs to
 * tell "nobody has paused this" from "we could not read it" — the distinction the guards
 * themselves turn on.
 */
autonomyRouter.get('/:conversationId', async (req, res) => {
  try {
    const result = await readLock(orgScope(req), req.params.conversationId);
    if (result.ok === false) {
      return sendError(req, res, result.code, result.message);
    }
    const { ok, ...body } = result;
    return res.json(body);
  } catch (e) {
    return sendCaught(req, res, e);
  }
});

/**
 * Pause or resume autonomy for one conversation.
 *
 * `POST /api/autonomy/:conversationId  { "paused": true, "reason": "customer called in" }`
 *
 * Attribution is checked BEFORE the body is validated, so a caller who may not act at all is
 * told that, rather than being walked through the shape of a request it is not allowed to make.
 */
autonomyRouter.post('/:conversationId', async (req, res) => {
  try {
    const attribution = attributedOrRefused(req, res);
    if (attribution === null) return;

    const result = await changeLock({
      orgId: orgScope(req),
      conversationId: req.params.conversationId,
      body: req.body,
      attribution,
      at: new Date().toISOString(),
    });

    if (result.ok === false) {
      return sendError(req, res, result.code, result.message);
    }
    const { ok, ...body } = result;
    return res.json(body);
  } catch (e) {
    return sendCaught(req, res, e);
  }
});
