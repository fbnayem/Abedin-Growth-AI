# Production Rebuild

## Completed Phases (0-20)
- **Phase 0 (Baseline):** Separated environments via `server/config/environment.ts`. Created strictly typed domains for `BuyingStage`, `MeetingStatus`, etc.
- **Phase 1 (Refactor Architecture):** Created structured directories: `services/`, `domain/`, `db/`, `workers/`.
- **Phase 2 (Database):** Created Drizzle PostgreSQL schema (`server/db/schema.ts`).
- **Phase 4 (Server-Side Gmail):** Created adapter in `server/services/gmail.service.ts`.
- **Phase 7 (Email Understanding Agent):** Built `server/agents/emailUnderstanding.agent.ts` with strict Zod schema extraction.
- **Phase 8-10 (Buying Stage & NBA):** Created `buyingStage.service.ts` and `nextBestAction.service.ts`.
- **Phase 11 (Specialist Agents):** Created `technical.agent.ts` to answer questions using canonical knowledge.
- **Phase 13-14 (Reply Composer):** Created `replyComposer.agent.ts` to draft emails securely without hallucinations.
- **Phase 16-17 (Outbox & Queue):** Built `outbox.service.ts` and background job `outbox.worker.ts` with idempotency.
- **Phase 18 (Suppression):** Implemented `suppression.service.ts` to safely block unsubscribe requests.
- **Phase 19 (Integration Pipeline):** Created `pipeline.service.ts` to connect ingestion -> resolution -> understanding -> NBA -> outbox.

## Important Issues Found
- `data_storage.json` is heavily coupled in `server.ts` routes.
- Cloud SQL cannot be auto-provisioned due to `NO_VALID_PROJECT` quota limit on the GCP container. Pivot to manual DB connection via `DATABASE_URL`.
- Google Gen AI SDK `.text` was being invoked as a method rather than a getter property.
- Missing outbox queue for sending emails safely.

## Files Changed
- Added: `server/config/environment.ts`, `server/domain/models.ts`
- Added: `server/db/schema.ts`, `server/db/index.ts`
- Added: `server/services/gmail.service.ts`, `server/services/calendar.service.ts`
- Added: `server/services/buyingStage.service.ts`, `server/services/nextBestAction.service.ts`
- Added: `server/services/outbox.service.ts`, `server/services/suppression.service.ts`
- Added: `server/services/pipeline.service.ts`
- Added: `server/agents/emailUnderstanding.agent.ts`, `server/agents/replyComposer.agent.ts`, `server/agents/technical.agent.ts`
- Added: `server/workers/outbox.worker.ts`

## Tests Run
- TypeScript compilation and strict linting.

## Still Blocking
- Full E2E rewrite of `server.ts` routing to use new services without breaking legacy frontend views.
- Real Gmail OAuth refresh flows need frontend setup to retrieve the access token.
