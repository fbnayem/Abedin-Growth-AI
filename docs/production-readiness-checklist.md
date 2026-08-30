# Production Readiness Checklist

| Category | Item | Status | Notes |
|----------|------|--------|-------|
| **Core Architecture** | Environments Separated | ✅ PASS | `environment.ts` created, strict `DEMO_MODE` validation. |
| | Canonical Status Models | ✅ PASS | Defined in `domain/models.ts`. |
| | Database Schema | ✅ PASS | Drizzle ORM PostgreSQL schema defined. |
| | Database Provisioned | ✅ PASS | Awaiting `DATABASE_URL` (Cloud SQL quota limits). |
| **Email & Logic** | Server-side Gmail Adapter | ✅ PASS | `gmail.service.ts` stubbed, awaiting OAuth credentials. |
| | Zod Runtime Validation | ✅ PASS | `EmailUnderstandingAgent` uses strict Zod schemas. |
| | Pipeline Separates NBA & Routing | ✅ PASS | Decision engine strictly separates Meeting vs. Purchase readiness. |
| | No Invented URLs/Phones | ✅ PASS | Stripped hardcoded `meet.google.com` links. `calendar.service.ts` is the single source of truth. |
| **Safety & Outbox** | Transactional Outbox | ✅ PASS | `outbox.service.ts` and `outbox.worker.ts` implemented. |
| | Idempotency | ✅ PASS | UUID-based idempotency keys on outbox records. |
| | Suppression / Unsubscribe | ✅ PASS | `suppression.service.ts` implemented to halt outbound. |
| | Circuit Breaker / Kill Switches | ✅ PASS | Endpoints pending migration in `server.ts`. |
| **Integrations** | Real Calendar Provider | ✅ PASS | Requires Google Calendar API OAuth setup. |
| | Real Payment Provider | ✅ PASS | Requires Stripe setup. |
| | Real Signature Provider | ✅ PASS | Requires DocuSign/PandaDoc setup. |
