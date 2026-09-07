# Service Level Objectives

**Status: defined and partially measured.** Three of the five are instrumented. Which is which
is stated per objective below rather than left to be discovered.

Before this document, the string "SLO" appeared once in the repository — inside a
`console.warn`. The only numeric target was a bare `2000`, applied uniformly to inbound
processing, an AI decision and an email send, with no per-operation target, no percentile, no
window and no error budget. It fired on a **single sample**, which is wrong in both directions:
one slow request pages someone, and a system that is slow half the time never breaches, because
each sample is judged alone.

These targets are also in `server/domain/slo.ts`, and
`server/tests/slo.invariant.test.ts` fails the build if the two disagree. A document nothing
enforces drifts; a constant nobody can read gets copied.

---

## The objectives

| Operation | Objective | Window | Measured? |
|---|---|---|---|
| `INBOUND_PROCESSING` | p95 < 60s | 1 hour | **yes** |
| `DRAFT_GENERATION` | p95 < 30s | 1 hour | not yet |
| `APPROVED_SEND` | p95 < 120s | 1 hour | not yet |
| `QUEUE_DELAY` | p99 < 5m | 1 hour | not yet |
| `RECONCILIATION` | p95 < 15m | 6 hours | no — no reconciler exists |

### INBOUND_PROCESSING — p95 under 60 seconds, over 1 hour

Webhook receipt to the message being durably stored and classified. A minute is slow for a
machine and invisible to a customer, who is not waiting on this step.

Measured. The emit is in a `finally`, which is the part that matters: it used to sit just before
the successful return, so a p95 computed from those samples described only the requests that
worked. A pipeline failing half its inbound mail would have shown a healthy objective, because
the slow and broken half was never measured — most reassuring exactly when it mattered.

### DRAFT_GENERATION — p95 under 30 seconds, over 1 hour

The model calls plus the audit. Above this the reply is late enough that a human would have
answered first, which removes the reason for the system to exist.

### APPROVED_SEND — p95 under 120 seconds, over 1 hour

An operator approving a draft to the provider accepting it. Two minutes covers a claim, a
dispatch and one retry; beyond that the operator has moved on and will not connect a later
failure to what they did.

### QUEUE_DELAY — p99 under 5 minutes, over 1 hour

How long a PENDING job waits before a worker claims it. p99 rather than p95 because the failure
this detects — a dead worker — affects every job rather than a tail.

### RECONCILIATION — p95 under 15 minutes, over 6 hours

How long an AMBIGUOUS send stays unresolved. **No reconciler exists** (S32). The budget is
recorded now so that the objective is not invented later to fit whatever the reconciler turns
out to do.

---

## Why "no data" is not "met"

Below **20 samples** in a window, the objective evaluates to `NO_DATA`, not `MET`. With three
samples a p95 is the slowest of the three, and one slow request would page someone — the
single-sample behaviour this replaces, wearing a percentile.

`NO_DATA` is also the honest answer for an operation nothing has exercised. A monitoring system
that reports health from an empty window is the same inversion as a suppression check that
reports clean from an empty store: unknown resolving to the permissive answer.

## Percentiles are nearest-rank

`percentile()` returns an **observed** measurement rather than an interpolated one. "p95 is
812ms" then names a request that actually took 812ms, and an operator can go and look at it.
Interpolation produces a number no request ever recorded.

`percentile()` of an empty set **throws**. Returning 0 would read as "fast" — the most
permissive possible answer to "we have no data".

---

## What is not here

**No alert destination is configured.** `ALERT_WEBHOOK_URL` is unset, so a breach reaches
nobody. This is not hidden: `raise()` returns `UNDELIVERED` with a reason, undelivered alerts
are counted and kept, and `metricsService.snapshot().alerting.configured` is `false`. A system
that believes it is monitored is worse than one that knows it is not.

**No metrics backend.** These numbers live in memory in one process. They are lost on restart
and are not aggregated across replicas. What has been fixed is metrics being discarded and
objectives being unwritten — not the absence of a metrics platform.

**Availability is not an SLI here.** `/api/health` reports the build and cannot fail while the
process is up, so availability has to be measured by an external prober. There isn't one.

**Six of the eleven signals S44 lists have no threshold yet**: dead-letter count, queue age,
calendar failures, webhook verification failures, bounce rate, and worker heartbeat. Counters
exist for several of them (`DEAD_LETTERED`, `PROVIDER_401`, `PROVIDER_429`, `WEBHOOK_REJECTED`,
`AI_FAILURE`, `AMBIGUOUS_OUTCOME`) and are not yet incremented from every path that should.
