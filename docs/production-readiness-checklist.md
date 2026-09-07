# RETRACTED — "Production Readiness Checklist"

**Retracted 2026-09-08.** Fifteen rows, every one marked ✅ PASS. Six of them said in their own
Notes column, on the same line, that the thing did not exist:

| Item | Status | Notes, verbatim |
|---|---|---|
| Database Provisioned | ✅ PASS | Awaiting `DATABASE_URL` (Cloud SQL quota limits). |
| Server-side Gmail Adapter | ✅ PASS | `gmail.service.ts` stubbed, awaiting OAuth credentials. |
| Circuit Breaker / Kill Switches | ✅ PASS | Endpoints pending migration in `server.ts`. |
| Real Calendar Provider | ✅ PASS | Requires Google Calendar API OAuth setup. |
| Real Payment Provider | ✅ PASS | Requires Stripe setup. |
| Real Signature Provider | ✅ PASS | Requires DocuSign/PandaDoc setup. |

"Awaiting", "stubbed", "pending", "requires" — and a green tick beside each. A row that certifies
a control as passing while stating that the control has not been built is not a mistake about the
code; it is a statement that the checklist's PASS column means nothing. Anyone reading the
Status column alone — which is what a checklist is for — is misled by the document working
exactly as designed.

Retracted rather than deleted, so the claim remains comparable against what was true.

---

## What each row actually meant

Read charitably, most of these rows were recording *"a file exists"*. That is a real thing to
track and it is not readiness. The distinction is the entire subject of Proof Addendum §47:
readiness must verify **capability**, not object existence.

- **Database Schema — "Drizzle ORM PostgreSQL schema defined."** True then, and it stayed true
  while the migrations silently stopped describing that schema. Three commits changed
  `server/db/schema.ts` without generating a migration, and `drizzle-kit check`, `tsc` and the
  whole test suite were green over it — each for its own separate reason. Fixed 2026-09-07 and
  now held by 29 invariants (S5).
- **Database Provisioned.** Now genuinely true: 6 of 6 migrations applied, 20 tables matching
  `schema.ts` column for column, a scoped application role, a verified TLS connection.
  Reproduce with `npm run db:verify`.
- **Zod Runtime Validation — "`EmailUnderstandingAgent` uses strict Zod schemas."** That agent is
  not on the live reply path. Zod validation *has* since arrived where it was missing and matters
  — the outbox consumer now parses every job payload against a strict schema before dispatch
  (S48) — but that is not what this row was claiming.
- **No Invented URLs/Phones — "`calendar.service.ts` is the single source of truth."** It is now
  imported by the action gateway, so the stronger form of this finding is out of date. It still
  mints nothing: `REAL_CALENDAR_CREATE_ENABLED` is false and bookings are recorded as
  `PENDING_CALENDAR_SYNC`.
- **Suppression / Unsubscribe — "`suppression.service.ts` implemented to halt outbound."**
  Implemented and unreachable: its only importer is `pipeline.service.ts`, which has none. The
  suppression check that *is* reachable reads the in-memory seed store, which the live inbound
  path never writes to — so it returns CLEAN for every recipient including one who has just
  unsubscribed. See `docs/audit-report.md` §3.
- **Idempotency — "UUID-based idempotency keys on outbox records."** The keys exist. The unique
  constraint enforcing them is on a Postgres table the live worker does not read.
- **Circuit Breaker / Kill Switches.** Now real, persisted, attributed, and refusing to report
  success when it cannot record the decision. It was `res.json({ success: true })` when this row
  was written.
- **Real Calendar / Payment / Signature Providers.** All three remain adapters behind flags that
  are `false` by design. Under the standing Safe Rebuild constraint they must stay false: no real
  email to a prospect, no real customer meeting, no real charge.

---

## The correct reading of the flags

`REAL_EMAIL_SEND_ENABLED`, `REAL_CALENDAR_CREATE_ENABLED`, `REAL_PAYMENT_ENABLED`,
`REAL_SIGNATURE_ENABLED` and `REAL_LINKEDIN_SEND_ENABLED` are all `false`, and that is the
intended state, not an outstanding task. A row reading "✅ PASS — Requires Stripe setup" inverts
that: it presents a deliberate safety posture as a completed integration.

---

## Where the live record is

`docs/production/addendum-status.md` — 49 sections, each with a state, decisive evidence and a
worst case. It records **zero** sections as VERIFIED and does not use a PASS column.

Nothing in this repository is currently a production-readiness certification, and the honest
summary is that the system has never sent an autonomous email in any environment.
