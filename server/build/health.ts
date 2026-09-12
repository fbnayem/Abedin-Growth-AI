import type { Provenance } from './provenance';
import type { SchemaCompatibility } from './schemaCompatibility';

/**
 * THE HEALTH ANSWER, SHAPED WHERE A TEST CAN REACH IT.
 *
 * This was five lines inside the `/api/health` handler in `server.ts`, and it survived a
 * mutant: replacing `const healthy = schema.state === 'MATCHED'` with `const healthy = true`
 * passed the entire gate. The suite asserted that the handler's SOURCE contained
 * `res.status(healthy ? 200 : 503)`, which is still true of a build that always says healthy.
 *
 * A source assertion cannot tell a decision from a decision that has been short-circuited. So
 * the decision moved here, where it is a function of its inputs and a test calls it.
 *
 * WHY THE STATUS CODE MOVES AND NOT JUST THE WORD
 * -----------------------------------------------
 * `status: "degraded"` inside a 200 response is invisible to every load balancer, uptime check
 * and orchestrator that reads the code and not the body. If a mismatched schema is a reason to
 * refuse sending, it is a reason to stop taking traffic; saying so only in JSON is saying it to
 * nobody.
 */

export interface HealthAnswer {
  readonly status: number;
  readonly body: {
    readonly status: 'ok' | 'degraded';
    readonly service: string;
    readonly build: Provenance;
    readonly schema: SchemaCompatibility;
  };
}

export const SERVICE_NAME = 'Abedin Growth AI Core Engine';

/**
 * `MATCHED` is healthy and nothing else is.
 *
 * Written as `=== 'MATCHED'` rather than `!== 'DATABASE_BEHIND'` so a state added later reports
 * degraded until somebody decides it is fine — the same reason the dispatch gate refuses an
 * unrecognised action type instead of allowing it.
 */
export function healthResponse(
  build: Provenance,
  schema: SchemaCompatibility
): HealthAnswer {
  const healthy = schema.state === 'MATCHED';
  return {
    status: healthy ? 200 : 503,
    body: {
      status: healthy ? 'ok' : 'degraded',
      service: SERVICE_NAME,
      build,
      schema,
    },
  };
}
