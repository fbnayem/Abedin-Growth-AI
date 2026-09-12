import type { Request, Response } from 'express';
import { sendError } from './errors';
import { type ContractBody, validateContractBody, type ContractRoute } from '../domain/apiContracts';

/**
 * S11 — validate a body against the route's contract, or answer VALIDATION_ERROR.
 *
 * Returns the PARSED value. A handler that validates and then persists `req.body` has
 * validated nothing: the check passes and the unvalidated bytes are what get written.
 *
 * Returns null when it has already answered, so the caller returns without a second response.
 */
export function parsedBodyOr400<R extends ContractRoute>(
  req: Request,
  res: Response,
  route: R
): ContractBody<R> | null {
  const outcome = validateContractBody(route, req.body ?? {});
  if (outcome.ok === false) {
    sendError(
      req,
      res,
      'VALIDATION_ERROR',
      `${route} rejected ${outcome.problems.length} field(s): ${outcome.problems.join('; ')}`
    );
    return null;
  }
  return outcome.value;
}
