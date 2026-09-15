# LinkedIn lead generation: a plan

**For:** the owner deciding what to fund, and whoever builds it. Written after reading what the
system actually does, not from what "LinkedIn lead generation" usually means.

**The short version.** LinkedIn is not a source of leads in this system. It is a source of
*identities without addresses*, and this system's identity key is the email address. That one fact
decides the architecture, and most of the work below is about it rather than about LinkedIn.

---

## 1. The finding that reshapes this

A contact's document id is derived from its email:

```ts
export function tryContactDocId(email: unknown): string | null {
  const key = normalizeEmailKey(email);
  return key === null ? null : derivedId('ct', key);
}
```

`validateCandidate` refuses with `NO_EMAIL` when there is none. That derivation is load-bearing
across the whole system — deduplication, the suppression list, `emailKey` lookups, the
unsubscribe token, the outbound Message-ID used for §32 reconciliation. It is not incidental.

LinkedIn gives you a name, a role, an employer and a profile URL. It does not generally give you
an email address. **So a LinkedIn profile cannot become a contact in this system.** Every plan
that starts "scrape LinkedIn, get leads" runs into this on day one, and the honest answers are:

- get the email from somewhere else (enrichment, or a form the person filled in), or
- do not create a contact at all, and treat the profile as a task for a person, or
- introduce a second identity key — which is a much larger change than it sounds, because
  suppression, opt-out and reconciliation are all built on the email one.

Everything below follows from that.

---

## 2. What already exists, and is free

Substantially more than I expected before looking:

| | |
|---|---|
| `linkedinUrl` | Already an allowlisted candidate field, already in the CSV alias map (`linkedin` → `linkedinUrl`), already on the contact document |
| `LINKEDIN_TASK` | Already a campaign step type. `campaignSequence.ts` parses it, the engine records it as *not performed* and moves on, and **nothing anywhere displays it**. A designed channel with no surface |
| `EXTERNAL_MESSAGE_SEND` | Declared on the gateway, classified irreversible, provider `linkedin`, capability `null`, and returns `UNSUPPORTED_ACTION` |
| `REAL_LINKEDIN_SEND_ENABLED` | One of the seven production-action flags. False, and covered by `isFullySafeMode()` |
| `HttpDiscoveryProvider` | A configured HTTPS adapter with a spend cap, §32 ambiguity handling and an SSRF-checked endpoint. An enrichment API is the same shape as a search API |
| The ingest spine | Four sources → one validator → one document builder → one write path. A fifth source is a new caller, not a new pipeline |

The expensive parts — the lawful basis gate, the Article 14 notice, the spend ledger, the
preview-before-commit pattern — are all built. What LinkedIn needs is mostly wiring plus one new
record type.

---

## 3. Five products, not one

"LinkedIn lead generation" names five different things with wildly different risk. Ranked by what
I would actually do:

### 3.1 Lead Gen Forms through the official API — **consented, and the cleanest**

Paid LinkedIn ads with an attached form. The person fills it in; LinkedIn hands you the
submission through the Marketing Developer Platform, **including an email address they typed
themselves**.

This is the only LinkedIn route where leads arrive with **CONSENT** as the lawful basis rather
than legitimate interest. No Article 14 notice is needed for it — the data came from the data
subject. No ToS question. No scraping. It costs ad spend instead of engineering risk.

It is also, notably, the route the memo I wrote last time under-covered. I was thinking about
outbound and skipped the inbound one.

### 3.2 List export → the CSV importer — **works today, if your licence allows it**

If your Sales Navigator tier permits exporting a lead list, the CSV importer already ingests it.
Export availability varies by tier and LinkedIn has changed it over time, so **check your licence
before anyone builds anything** — and check whether your export actually contains email addresses,
because many do not.

Where the export has no email, you are in 3.3.

### 3.3 LinkedIn as research, with a person doing the work — **zero risk, real value**

A profile URL attached to a record, and `LINKEDIN_TASK` steps surfaced as a queue somebody works
through: open the profile, decide if it is worth pursuing, find the address, or send a connection
request by hand. No automation touches LinkedIn at all. A person using a website as a person.

This is the half that is nearly built and completely invisible.

### 3.4 Email enrichment through a licensed provider — **what unlocks volume**

Send a LinkedIn identity to a provider that is licensed to return a work email; receive a contact
this system can actually hold. The discovery adapter is already the right shape for it: the same
spend cap, the same `validateCandidate` treatment of the response, the same refusal to accept a
provider's opinion that a record is "verified" as consent.

This is what turns 3.3's pile of profile URLs into mailable contacts, and it does it by paying a
vendor who carries the compliance rather than by scraping.

### 3.5 Scraping profiles, or automated messaging — **the gated one**

Covered in `linkedin-decision.md` and unchanged: the User Agreement prohibits it, enforcement is
routine, the *hiQ* line of cases did not establish a right to scrape, and the exposure is personal
to whoever accepted the agreement.

There is also an **architectural** objection, separate from the legal one, and it is the one I
would lead with:

> **Every send path in this repository refuses when it cannot attach an opt-out that we control.**
> `executeEmailSend` refuses on `unsubscribe.ok === false`. So does the Article 14 notice sender.
> The comment on that check reads: *the permissive reading of "we could not build an opt-out" is
> to mail somebody who then has no way to stop us.*
>
> LinkedIn messaging has no opt-out mechanism we control. Building 3.5 means either solving that
> or making this the first send path in the system that is exempt from it — and an exemption is
> how the rule stops meaning anything everywhere else.

---

## 4. The phases

Each ends with the §B gate — compiles, migrations valid, tests pass, frontend build, production
build — and each carries its own proof obligation, because under the addendum compilation is not
done.

### LP1 — the prospect record: a person we cannot yet email

**The problem.** A LinkedIn identity with no email cannot be a contact, and must not be forced
into being one. A half-formed contact with a placeholder address would be a record the lawful
basis gate cannot reason about, sitting in the same collection as records it can — which is how
a gate stops being trustworthy.

**The build.** A new tenant-scoped `prospects` collection, deliberately *not* `contacts`:

- identity derived from the **canonical LinkedIn profile URL**, not the email — so a new
  `normaliseProfileUrl` that strips tracking parameters, lower-cases, drops the locale prefix and
  the trailing slash, and refuses anything that is not a `/in/` or `/company/` path;
- fields limited to what LinkedIn actually gives: name, headline, role, employer, employer
  website, location, profile URL. **No email field at all** — a prospect that had one would be a
  contact;
- `source` and `sourceEvidence` recorded exactly as the ingest does today;
- a `promotedToContactId`, set when an email is found, so the two records are linked rather than
  duplicated;
- one write path, `promoteProspect(prospectId, email, …)`, that goes through `validateCandidate`
  and `ingestRecords` like every other source.

**Proof.** A prospect cannot be emailed by any path — asserted by a test that walks every dispatch
site. Promotion is idempotent under a duplicate email. A prospect whose URL normalises to an
existing one is a duplicate, not a second record. Mutants: strip the normaliser, accept an email
on a prospect, let `promote` bypass the validator.

**Cost.** ~2 days.

### LP2 — the list-export preset

**The build.** A column-mapping preset for LinkedIn's export shapes so a list drops straight into
`/api/leads/import` without the operator hand-mapping fourteen columns. Rows with an email become
contacts; rows without become prospects (LP1). The importer's preview already reports both.

**Proof.** A fixture of each export shape maps every column or reports it as ignored — an unmapped
column is an operator mistake and the importer already says so. Mutants: mis-map a column,
silently drop the emailless rows.

**Cost.** ~half a day, and it is worthless until somebody confirms the licence allows the export.

### LP3 — the LinkedIn task queue

**The build.** Surface what `campaignSequence` already produces. A view listing every
`LINKEDIN_TASK` step recorded as not-performed, with the contact or prospect, the profile link,
the step's own template as suggested copy, and a "done" / "no reply" / "not the right person"
outcome written back.

**Why it is worth more than it sounds.** It converts a step the engine currently *skips and
records* into a channel with a human in it. That is the only kind of LinkedIn outreach with no ToS
exposure, and the engine was already designed for it.

**Proof.** A task marked done is recorded against the contact and never re-offered. Marking "not
the right person" sets `wrongPerson`, which the campaign safety guards already read. Mutants:
re-offer a completed task, let the queue show another tenant's tasks.

**Cost.** ~1 day.

### LP4 — enrichment through the discovery adapter

**The build.** A second mode on `HttpDiscoveryProvider`: lookup-by-identity rather than
search-by-filter. Same config shape, same field map, same spend cap, same §32 handling — an
ambiguous enrichment records the ceiling and refuses rather than retrying.

Then a service that takes a batch of prospects, enriches, and promotes the ones that come back
with a usable address. Preview first, like everything else.

**The compliance work this needs, which is not optional:**

- **A new balancing assessment.** The signed UK assessment covers work addresses collected from
  company websites. A LinkedIn-sourced identity enriched by a third party is different data from a
  different source, and the existing assessment does not cover it. `assessmentVerdict` would not
  catch this — it checks country coverage, not source coverage — so **this is a human obligation,
  not a mechanical one**, and it should be written down as such.
- **The Article 14 source line must say what actually happened**: identified on LinkedIn, address
  supplied by a named provider. The notice already reads the contact's own provenance, so this is
  a matter of recording provenance honestly at promotion time, not of writing new template prose.
- **Country coverage.** The provider will cover countries our table does not. Records outside the
  six refuse at the gate, which is correct — but the spend happens before the refusal, so the
  enrichment service should filter by country *before* it calls, the way `discoverLeads` already
  does.

**Proof.** An ambiguous enrichment records the ceiling and does not retry. A provider response
cannot set a suppression flag or nominate a basis. A prospect in an uncovered country is not
enriched at all, so no money is spent on a record that can never be used. Mutants: drop the
pre-call country filter, accept a provider's `consentGiven`, retry on ambiguity.

**Cost.** ~2 days, plus whatever the vendor costs.

### LP5 — Lead Gen Forms

**The build.** A webhook endpoint for form submissions, verified with the existing
`webhookVerification` service, creating contacts with **`lawfulBasis: 'CONSENT'`**, the evidence
being the form submission itself, and `consentRecordedBy` the integration.

**The one thing to get right.** The existing consent path requires `consentEvidence` and
`consentRecordedBy`. A form submission genuinely satisfies both, and the temptation will be to
write "linkedin" in the evidence field. It should carry the form id, the submission id and the
timestamp — enough that somebody could go and look it up, which is the standard the gate's own
comment sets.

**Proof.** An unverified webhook creates nothing. A replayed submission is idempotent. Consent
evidence that is not traceable is refused. Mutants: skip signature verification, accept a
submission with no form reference.

**Cost.** ~2 days. Needs a LinkedIn developer application and ad spend to produce anything.

### LP6 — automated messaging *(gated, and I would argue against)*

Not costed, because I do not think it should be built, and a cost estimate invites treating it as
scheduled. What it would require, so the decision is made with the real list in front of you:

1. **A second identity key.** Suppression, deduplication and reconciliation are all built on
   `emailKey`. A LinkedIn-addressable person with no email needs a parallel key through all three.
2. **An opt-out we control** — see §3.5. This is the blocking one.
3. **A new lawful basis analysis.** LinkedIn messaging is electronic direct marketing; Germany
   needs prior consent for it exactly as for email, and there is no carve-out that makes the
   channel special.
4. **An `EXTERNAL_MESSAGE_SEND` executor**, with its own checks, behind the existing flag.
5. **The ToS decision**, in writing.

---

## 5. Recommended sequence

**LP1 → LP3 → LP4**, with **LP2** dropped in as soon as somebody confirms the licence, and **LP5**
run in parallel if you are willing to spend on ads.

The reasoning: LP1 is the unlock — nothing else about LinkedIn is expressible in this system until
a person can exist without an address. LP3 is cheap, uses something already built, and is the only
LinkedIn outreach with no exposure at all. LP4 is what makes it scale, and it scales by paying a
vendor to carry the compliance rather than by taking it on ourselves.

**One caveat worth weighing before any of it.** The audience the signed assessment describes is UK
dental and healthcare practices. For a six-person practice, the manager's address is on the
contact page and the practice website is a *better* source than LinkedIn. LinkedIn earns its cost
when you need the right one of four hundred people at a large company. **If the target audience
has not changed, this whole plan is lower value than the work already shipped** — and I would
rather say that now than after LP4.

---

## 6. The decision still open

`linkedin-decision.md` asked for A, B, C or D. This plan reframes it:

- **LP1–LP5 need no LinkedIn-risk decision at all.** None of them automates anything against
  LinkedIn. They need a budget decision and, for LP2, a licence check.
- **LP6 needs the decision**, and it now has an architectural objection alongside the legal one:
  it would be the first send path in this system exempt from the opt-out rule.

If you want LP6 anyway, I will build it, and the first thing I would build is the opt-out — not
the sender.
