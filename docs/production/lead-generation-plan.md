# Lead generation: the plan, and what was built against it

**Status: delivered.** Proposed 2026-09-15 against commit `dde849d`; completed the same day
across seven commits, `6a05e9a` to `f2ecd26`. Section 9 records what each phase actually
produced and what proves it; section 10 records what is still an owner decision.

The plan below is left as it was written, including the parts it got wrong, because a plan
edited to match its outcome stops being evidence of anything.

This plan is written to the same standard as the rest of `docs/production/`: it states what is
true now, what will change, and what will prove it. Nothing here is complete until an executable
test asserts its invariant and that test has been shown to fail when the behaviour is broken.

---

## 1. The finding this plan is built around

**A lead created today can never be emailed. Not by a campaign, not by any path.**

- `ActionGateway` refuses every send where `contactData.consentGiven !== true`
  (`server/gateway/actionGateway.ts:854`). Unknown consent is treated as insufficient data and
  routed to a human, never read as permission.
- `createContactSchema` deliberately does **not** accept `consentGiven`
  (`server/lib/validation.ts:52`). Accepting it from a request body was a mass-assignment hole
  and was closed on purpose.
- `buildContactDocument` never writes the field
  (`server/routes/contacts.routes.ts`), so a new lead has it undefined.
- The only writer outside the gateway's own internal object is the contact merge
  (`server/domain/contactMerge.ts:246`), and all that does is carry an existing `true` from a
  duplicate onto a survivor.

Nothing in the system can set that first `true`. It is a closed loop with no entrance.

A second, quieter instance of the same problem: the gateway also refuses any recipient whose
`country` is not a valid ISO code (`actionGateway.ts:864-872`), and the create path stores
`country: null` when it is not supplied.

**Consequence for this plan.** Discovery is not the first problem. Any amount of lead
generation built before this is fixed produces records that are permanently unusable. Phase 1
is therefore the unlock, and every other phase depends on it.

---

## 2. What already works and will be reused, not rebuilt

The foundations are good, which makes this a smaller job than it appears.

| Capability | Where | Why it matters here |
|---|---|---|
| Derived contact ids, dedup by construction | `server/lib/identityStore.ts` | Bulk import cannot create duplicates; the id comes from the normalised address |
| Create-or-refuse transaction | `identityStore.ts` | A re-import can never silently clear an unsubscribe |
| Consent-safe merge | `server/domain/contactMerge.ts` | Reports inherited suppression and revoked consent to the caller |
| CSV formula neutralisation | `shared/lib/csvSafety.ts` | Import can reuse the same safety the exporter already has |
| Provider adapter contract | `server/providers/types.ts` | A discovery provider is a new adapter, not a new pattern |
| Per-tenant spend gate | `server/services/tenantSpend.service.ts` | Paid lookups get a daily and monthly cap that fails closed |
| HTTP client with mandatory timeout | `server/lib/httpClient.ts` | Every scrape and every provider call is bounded |
| Prompt authority separation | `server/lib/promptAssembly.ts` | Scraped text is untrusted data and must never gain instruction authority |
| Campaign engine, enrolment, outbox, gateway | various | Already correct; waiting only on mailable contacts |

---

## 3. Phase 1 — Lawful basis and provenance

The unlock. Nothing else ships without it.

### What a contact gains

| Field | Purpose |
|---|---|
| `lawfulBasis` | `CONSENT` or `LEGITIMATE_INTEREST`. Absent means no basis, which refuses. |
| `consentGiven`, `consentSource`, `consentEvidence` | What was agreed, where, and the evidence for it |
| `consentRecordedAt`, `consentRecordedBy` | When, and which identified person recorded it |
| `liaId` | Which legitimate-interests assessment covers this contact |
| `article14NoticeSentAt` | When the data-subject notice was sent, for indirectly collected data |
| `source` | `MANUAL`, `IMPORT`, `PROVIDER:<name>`, `SCRAPE:<domain>` |
| `sourceEvidence`, `sourceCollectedAt` | Where the record came from and when |
| `country` | Required. Already enforced at the gateway; now enforced at creation. |
| `addressType` | `PERSONAL` or `ROLE`. A role address such as `info@` is not the same category of personal data as a named individual. |

### The basis gate

Replace the single `consentGiven !== true` check with an evaluation that keeps the same
fail-closed shape:

- `CONSENT` passes when consent is recorded, evidenced and not revoked.
- `LEGITIMATE_INTEREST` passes only when **all** hold: the country permits it, a legitimate
  interests assessment is on file, the Article 14 notice has been sent, and the address is a
  business address.
- Anything unknown refuses. An absent basis is not a permissive one.

This is the existing §14 rule applied to a richer model, not a relaxation of it.

### Why the Article 14 gate matters operationally

Where a lead was collected indirectly, which means every imported, purchased and scraped
record, the UK GDPR and EU GDPR require the person to be told where their data came from,
generally within one month and before or at first contact. Legitimate interest is a real and
commonly used basis for B2B outreach, but it is only defensible when that notice and a
balancing assessment exist.

Building it as a precondition rather than a policy document turns a compliance obligation into
a mechanical gate, which is the same approach the rest of this repository takes to safety.

### Proof for Phase 1

- An absent, malformed or unknown basis refuses.
- Legitimate interest without a notice refuses; with one, passes.
- Legitimate interest in a country that does not permit it refuses.
- A revoked consent cannot be restored by re-creating or re-importing the contact.
- A merge cannot upgrade a basis or resurrect a revoked consent.
- Recording a basis requires an identified actor, as quote approval already does.
- Mutation run against each assertion.

---

## 4. Phase 2 — Ingestion

Four sources, one write path. Every source ends at the same create-or-refuse transaction, so
dedup, no-overwrite and provenance are free rather than reimplemented per source.

### 2a. CSV and list import

- Upload or paste, header mapping, per-row validation.
- **Dry run first.** The preview reports how many rows would be created, how many are duplicates
  of existing contacts, and every row that would be refused with the reason. Nothing is written
  until the operator commits.
- Basis captured for the batch with evidence, or per row.
- Injection-safe parse, reusing `shared/lib/csvSafety.ts`.
- Size cap, with the refusal stated rather than silently truncated.

### 2b. Manual entry

Extend the existing Add Lead form with the basis fields. Smallest change of the four.

### 2c. Discovery provider

- A `DiscoveryProvider` adapter implementing `server/providers/types.ts`: declared capabilities,
  classified errors, provider-issued record ids.
- Behind its own flag, off by default, in the same style as the five existing action flags.
- Every lookup priced and charged through `tenantSpendGate` and `recordTenantSpend`, so a
  runaway search hits a daily and monthly ceiling that fails closed.
- All calls through `fetchWithTimeout`.
- Results written with `source: PROVIDER:<name>` and the lookup evidence retained.

### 2d. Scraping agents

Built in-house, as requested. The architecture is the same as any other source: a worker
produces candidate records, and they enter through the one create path.

- **Politeness and legality by construction:** `robots.txt` honoured, per-domain rate limiting,
  a declared user agent, mandatory timeouts, and a per-run page budget.
- **Scraped content is untrusted.** Under §18 it never reaches a model prompt with authority;
  it goes through `promptAssembly` as labelled, fenced data, exactly as inbound email does.
- **Provenance is mandatory.** Source URL, fetch timestamp and the extracted fields are stored
  with the record, so any lead can be traced to the page it came from.
- **The basis gate still applies.** A scraped lead is not special-cased. It carries
  `LEGITIMATE_INTEREST` at best, and cannot be emailed until the Article 14 notice is sent.

**On LinkedIn specifically, stated plainly so the decision is informed.** Scraping LinkedIn
breaches their User Agreement. In the United States the Ninth Circuit found in *hiQ Labs v.
LinkedIn* that scraping public profiles likely does not violate the Computer Fraud and Abuse
Act, but hiQ still lost on breach of contract and was permanently enjoined in 2022. So it is a
contract problem rather than a criminal one, and the practical risk is operational: LinkedIn
detects automation and bans accounts and addresses, including accounts you may need for other
purposes. The lower-risk equivalents are their official partner APIs or a licensed data vendor,
both of which fit the Phase 2c adapter without any change to this design. The scraping
architecture below supports a LinkedIn source if you choose it; this document records the
trade-off rather than deciding it.

Company-website scraping for firmographics and published role addresses carries materially less
risk than scraping named individuals' profiles, and is the sensible first target.

---

## 5. Phase 3 — Honest qualification

`ScoreBreakdown` already defines fit, pain probability, intent, decision-maker quality and
contactability. The deleted generator filled these with random numbers between 70 and 89 so the
result looked researched.

- Each component is computed from fields that actually exist on the record, against a written
  rubric stored with the score.
- A component with no input is **not scored**, and the total says so. It does not default to a
  middle value, because a fabricated middle is indistinguishable from a measured one.
- The rubric version is stored with each score, so a score can be explained later.

---

## 6. Phase 4 — The console

- An import screen with the dry-run preview and the refusal report.
- Lawful basis visible and editable on a lead, showing source, evidence and notice status.
- Enrolment into a campaign from the leads list, which has no screen at all today.
- Provenance shown on the lead detail: where this record came from.
- The dead "Discover with AI" button at `src/pages/LeadsView.tsx:301` either wired to the real
  provider or removed. It currently calls an endpoint that answers 501.

---

## 7. Phase 5 — Proof

Per the addendum, each area closes only with an executable invariant test that has been shown to
fail. Suites to add:

| Suite | Asserts |
|---|---|
| `lawfulBasis.invariant` | Every refusal path in section 3 |
| `leadImport.invariant` | Dry run writes nothing; duplicates refuse; injection neutralised; caps refuse |
| `discoveryProvider.invariant` | Flag off refuses; spend cap refuses; timeout is ambiguous, not failure |
| `scrapeWorker.invariant` | robots.txt honoured; rate limit holds; scraped text never gains prompt authority |
| `leadScore.invariant` | A missing input yields "not scored", never a default |

Closed with mutation runs against each, and a live dry run in which a real sequence advances and
the gateway refuses at the final hop because sending is off.

---

## 8. Order of work

1. **Phase 1**, because nothing is usable without it.
2. **Phase 2a and 2b**, which make the system useful with lists you already own.
3. **Phase 4** for those two, so it is operable from the console rather than by API call.
4. **Phase 3**, so scoring stops being a gap.
5. **Phase 2c**, the paid provider.
6. **Phase 2d**, the scraping agents, last because it is the largest and the one whose inputs
   the others make safe.

Phase 5 is not a stage at the end. Each phase closes with its own proof before the next starts.

---

## 9. What was built, and what proves it

Eight commits, `6a05e9a` through the one carrying this section. The gate at the end:
**97 suites, 2,498 tests, exit 0**; client bundle 1,321,122 bytes with no development markers; OpenAPI 106 routes, 22 with a
request contract; the code graph clean at 212 live modules and zero dead files.

| Phase | Delivered | Proven by | Mutation |
|---|---|---|---|
| 1. Lawful basis | `server/domain/lawfulBasis.ts`, `services/lawfulBasis.service.ts`, three endpoints | `lawfulBasis.invariant` (28), `lawfulBasisWrite.invariant` (39) | 17/17 + control, 3/3 + control, 17/17 |
| 2a. CSV import | `domain/leadImport.ts`, `domain/leadCandidate.ts`, `services/leadImport.service.ts`, `POST /api/leads/import` | `leadImport.invariant` (48) | 23/23, one control |
| 2b. Manual entry | basis fields on `createContactSchema`, refused without an identified operator | `validation.invariant` | covered above |
| 2c. Discovery | `providers/types.ts` contract, `services/discovery.service.ts`, `POST /api/leads/discover` | `discoveryProvider.invariant` (28) | 19/19, two controls |
| 2d. Scraping | `domain/crawlTarget.ts`, `domain/robots.ts`, `domain/pageExtraction.ts`, `services/scrapeWorker.service.ts`, `POST /api/leads/scrape` | `scrapeWorker.invariant` (44) | 35/35, one control |
| 3. Qualification | `domain/leadScore.ts`, `services/leadScore.service.ts`, two endpoints | `leadScore.invariant` (32) | 19/19, one control |
| 4. Console | `LeadSourcesView`, `LawfulBasisPanel`, `LeadScoreCard`, `EnrolInCampaignModal` | `leadConsole.invariant` (20) | 7/7, one control |

**142 mutants, every one behaving as required**, eight of them controls that had to survive.

### The mutation harness was wrong, and it was wrong in the flattering direction

The first run of the decision module reported its control as KILLED — a mutant that adds only a
COMMENT, which cannot change behaviour. It had not been killed. `vitest` exits non-zero both when
a test fails and when the runner itself falls over, and eighteen runs back to back made the
second happen: `Cannot read properties of undefined (reading 'config')`, suite never loaded, zero
tests executed, exit 1. The harness read that as a kill.

That is the worst possible direction for a measurement error, because it credits a suite with
catching something it never ran. Every harness now re-runs a suspected crash once — a real kill
is deterministic, a flaky worker is not — and reports it separately if it recurs. **Every batch
above was then re-run from scratch under the corrected harness**, and the figures are those runs,
not the earlier ones.

Two further things fell out of the re-run, both of which had been silently unproven:

- **Four import mutants had stopped applying.** Their anchors moved into `leadCandidate.ts`
  during the one-write-path refactor, and an anchor that matches zero times is skipped with a
  note that is easy to read past. The field-length cap, the formula neutralisation, the malformed
  country and the unreadable notice timestamp were all unverified in that run. Repointed; all
  four kill.

- **`recordArticle14Notice` had no test at all.** Found the same way: adding it beside
  `recordLawfulBasis` made two writer anchors match twice. It is the one call that turns a record
  the gate refuses into one it permits, in batches of up to five hundred, and nothing asserted
  that it requires a named actor, that it refuses without evidence, that it does not re-stamp an
  existing notice, or that it writes nothing else. Nine tests and five mutants now cover it.

### The four things the plan did not anticipate

1. **Legitimate interest accepted a free-mail address.** The module header documented "a business
   address rather than a personal one" while the code accepted `addressType: PERSONAL`, so a
   bought list of gmail addresses would have passed. Two different questions had been conflated:
   `addressType` is about what category of personal data a record holds, and both answers are
   compatible with the basis; corporate-versus-individual subscriber is answered by the domain.
   `LI_PERSONAL_ADDRESS` became `LI_ADDRESS_TYPE_UNKNOWN`, which is what it actually tests, and
   `LI_INDIVIDUAL_SUBSCRIBER` was added.

2. **Four sources meant one write path, or it meant nothing.** The plan said so; making it true
   required extracting `services/leadIngest.service.ts` and `domain/leadCandidate.ts` after the
   importer was already written. A test now asserts the importer holds no write of its own.

3. **Server-side request forgery is the scraper's real hazard**, and the plan did not mention it.
   `domain/crawlTarget.ts` refuses IP literals, non-web ports, credentials in a URL and reserved
   names, and then RESOLVES the hostname and checks every address — because a hostname is not a
   promise about an address, and `metadata.attacker.example` can have an A record pointing at
   `169.254.169.254`. DNS rebinding remains open and is written down in the module rather than
   left to be discovered.

4. **A batch notice endpoint was necessary for legitimate interest to be usable at all.**
   Recording the Article 14 notice one contact at a time through the basis endpoint is not a
   workflow anyone completes for a 900-row list, so `POST /api/leads/notice-sent` exists. Its
   timestamp is the moment of the call, never a parameter.

### Live verification, 2026-09-15

Against a running server on the real database, using preview and refusal paths only, so nothing
was written:

| Probe | Result |
|---|---|
| Readiness | seven flags, all false, `allExternalActionsDisabled: true` |
| Import body claiming `consentGiven` | 400, `Unrecognized key: "consentGiven"` |
| File columns named `consentGiven`, `unsubscribed`, `organizationId` | ignored and reported; `consentGiven` written as `false` from the basis |
| Import preview, complete legitimate-interest batch | 1 would be created, **0 contactable**, `LI_NOTICE_NOT_SENT` |
| Commit carrying another file's plan hash | 400, `PLAN_CHANGED` |
| Row with `country: United Kingdom` | refused, `BAD_COUNTRY`, named with its line number |
| Discovery, flag off | 501, nothing called, nothing charged |
| Scrape, flag off | 501, no request left the process |
| Scrape `http://169.254.169.254/...`, flag ON | 403 `IP_LITERAL`, refused before the network |
| Scrape `http://localhost:5432/`, flag ON | 403 `BAD_PORT` |
| Scrape `file:///etc/passwd`, flag ON | 403 `BAD_SCHEME` |

With the scrape flag on, `allExternalActionsDisabled` correctly read `false` — the aggregate
covers the two new flags. It was switched off again immediately; neither flag is in `.env`.

---

## 10. What is still an owner decision

Nothing below is a gap in the code. Each is something only the owner can settle.

1. **The country table in `server/domain/lawfulBasis.ts` needs legal review before it is relied
   on.** Six countries, deny-by-default, drawn from the commonly stated position in each
   jurisdiction and marked as needing checking. The distinctions are genuinely fine — under UK
   PECR a sole trader and a limited company at the same address are treated differently — and
   this is not the right source for that.

2. **A legitimate interests assessment has to exist.** The system requires an `liaId` and stores
   it; it does not and cannot write the assessment. Importing on legitimate interest without one
   on file means the id references nothing.

3. **The Article 14 notice has to actually be sent.** The endpoint records that you sent it. It
   does not send it, and the timestamp is the moment of the call precisely so that it cannot be
   a claim about a past nobody can check.

4. **No discovery adapter ships with this repository.** The contract, the flag, the spend cap and
   the ambiguity handling are all in place; an adapter for a specific vendor is a registration
   against `registerDiscoveryProvider`. Writing one against an API nobody has bought would be
   code whose behaviour nothing could check.

5. **Scraping LinkedIn remains the decision section 4 described.** The architecture supports it;
   the trade-off is unchanged, and the lower-risk equivalents — their partner APIs or a licensed
   vendor — fit the 2c adapter without any change to this design. Company-website scraping, which
   is what the worker is built and tested for, carries materially less risk.

6. **Sending is still off.** `REAL_EMAIL_SEND_ENABLED` is false, as are the other six. Leads can
   now be created, qualified, made lawfully contactable and enrolled into a campaign; the gateway
   refuses at the final hop by design, and turning that off is a separate decision with its own
   preconditions — Google Postmaster verification and the deliverability items in
   `addendum-status.md`.

---

## 11. P6 — closing out section 10

Section 10 listed six things that were "an owner decision". Asked to complete all of them, four
turned out to be things this system could and should have been doing, one was a document that
could be drafted but not signed, and one is a decision that stays the owner's.

The pattern across the four is the same and worth naming: **each was a rule this repository
STATED and did not ENFORCE.** A comment saying the country table needs review. A field called
`liaId` that accepted the letter `x`. An endpoint recording that a notice had been sent, with
nothing anywhere able to send one. The addendum's own argument — that a rule living only in a
document will be forgotten — applied to the lead system's compliance controls and had not been
applied to them.

### 11.1 The country table (was item 1)

The citation is now the row. `CountryRule` requires at least one `LegalSource` — instrument,
provision, and what that provision says — so adding a country is mechanically an act of citing
something. Each row also carries the specific questions a reviewer must answer and an honest
`confidence` marker; two of the six are marked CONTESTED, because they are.

A `review` field records who signed the row off, when, and under what matter reference. All three
are required: a sign-off nobody can trace is the same as no sign-off. Every row is null today.

**The enforcement is tied to the send flag, not to the environment.** `evaluateLawfulBasis` takes
`requireReviewedRegime`, and `ActionGateway.executeEmailSend` passes
`isRealActionEnabled('REAL_EMAIL_SEND_ENABLED')`. Development and preview are unaffected; the
moment real sending is turned on, an unreviewed country refuses with
`COUNTRY_NOT_LEGALLY_REVIEWED`.

Making it unconditional was the obvious design and it is wrong. Every row is unreviewed, so an
unconditional check would make the whole system unmailable until a solicitor had been paid — and
the pressure that creates is to fill `review` in with something plausible to get moving. A control
people are motivated to defeat is worse than one placed where the motivation runs the other way.

`docs/production/legal-review-pack.md` is the same material written for the reviewer, and an
invariant test keeps it from drifting: it must name every country in the table, state the regime
applied there, and ask at least as many questions as the table records. That test counts rather
than matching wording — a test coupling prose to code strings gets "fixed" by being weakened.

### 11.2 The balancing assessment (was item 2)

This was the worst of the six, because it read as a check and was a formality:

```ts
if (nonEmptyString(facts.liaId) === null) { ... 'the assessment is what makes the basis defensible' }
```

Typing `x` satisfied it. The gate that exists to stop unknowns becoming permissions contained, in
its own file, exactly the defect it was built to remove.

An assessment is now a stored document with the three limbs of the balancing test as separate
fields, each with a floor on its length; the countries it covers; the data categories, sources and
safeguards that are inputs to the test; and a signature. `POST /api/lia`, `POST /api/lia/:id/sign`,
`/amend`, `/withdraw`, and a listing that says of each one whether it is usable and why not.

Four properties carry the weight:

- **A draft supports nothing.** Unsigned is not a state the old string check could even express.
- **A signature freezes the text.** Amending a signed assessment is refused inside the
  transaction, against the stored record — a check outside it is one a concurrent signature walks
  past. The remedy for a wrong assessment is to withdraw it and write another.
- **Withdrawal and expiry take effect by being TRUE.** The gate resolves the assessment at send
  time, so a withdrawal at 09:00 stops the 09:01 send with no write to any contact record.
- **The signer comes from the credential**, never from a field. A create that could sign itself
  would make the signature worth what any self-reported field is worth.

The gate's strict mode is again tied to the send flag, and an UNRESOLVED assessment under strict
mode is a refusal (`LI_ASSESSMENT_NOT_RESOLVED`), not a pass — a caller that asks for the strict
check and forgets the lookup has a bug, and treating that as permission is the failure that
matters.

`docs/production/lia-uk-b2b-2026.md` is a drafted assessment. It is explicitly a proposal from the
engineer who built the system to the person who will own the risk, and it names the two places the
balance is genuinely uncomfortable rather than presenting a clean pass.

### 11.3 The Article 14 notice (was item 3)

`recordArticle14Notice` recorded that a notice had been sent. Nothing sent one. Since that field
is the precondition for legitimate-interest outreach, the operator's route to a mailable contact
was to assert the notice had happened — and the system believed them.

There is now a `PRIVACY_NOTICE_SEND` action type on the gateway. **A separate type, not a
convenience:** `executeEmailSend` refuses any contact whose notice has not been sent, so routing
the notice through it would require the lawful basis that the notice itself creates. A circular
dependency with a legal shape.

The notice is assembled, not templated. Every required element has exactly one source and a
missing source is a refusal rather than a blank line — the controller details from organisation
settings, the purpose and data categories from the signed assessment, and **the source line from
this contact's own provenance record**. That last one is what a generic template always gets
wrong: telling somebody "from publicly available sources" when the record was bought is a false
statement in the one document whose entire purpose is to be accurate.

What it checks, and what it deliberately does not, is argued in the module header: suppression
still refuses; the lawful basis is NOT consulted; the campaign safety guards are NOT run, because
frequency caps and quiet hours govern marketing volume and this is a legal notice with a deadline.

**The §32 lean is the opposite of a marketing send, and deliberately.** Two harms are available
and they are not symmetric:

| | |
|---|---|
| Record "sent" when it was not | somebody is marked mailable and receives marketing without ever having been told where we got their data. A legal failure, and silent. |
| Record "unsent" when it was | somebody may receive the same notice twice. Untidy. Nobody harmed. |

So the ambiguous case fails closed on PERMISSION: `article14NoticeSentAt` is not written, the
contact stays unmailable, and the attempt is recorded separately as ambiguous so it is visible
rather than lost. A retry then requires `acknowledgesPossibleDuplicate`, so a second copy is a
decision somebody makes rather than something a backoff loop does for them.

The manual recording endpoint stays. An operator who sent the notice by letter has to be able to
record that, and removing the path would not stop them — it would make them tell the system
something untrue instead.

### 11.4 The discovery adapter (was item 4)

Section 10 said writing an adapter against an API nobody has bought would be code nothing could
check. That is right about a **vendor-specific** client — request shapes, pagination, error
envelopes and billing semantics all differ. It is not right about the shape every one of them
shares: an HTTPS endpoint, a bearer credential, a JSON body of filters, and an array of records
somewhere in the response.

`HttpDiscoveryProvider` implements that shape and is configured rather than hardcoded. Pointing it
at a vendor is a URL, a key and a field map. The configuration **cannot widen what the system
accepts**: the map chooses which of THEIR keys fill OUR fields, and ours are a fixed list that
excludes `consentGiven`, `suppressed`, `lawfulBasis` and `liaId` — so a hostile or careless config
still cannot introduce them. The mass-assignment defence is in the shape of the mapping, not in
the care taken writing it.

The endpoint goes through the same `checkCrawlTarget` resolution the scraper uses, plus an HTTPS
requirement: a configured URL is still an input, and "it was in the environment" is not a
provenance that makes an address safe.

One decision worth recording: **an unreadable response is AMBIGUOUS, not a clean failure.** Bytes
came back, so the provider ran the query and in all likelihood charged for it. `INVALID_REQUEST`
would classify it NOT_APPLIED, record no spend, and licence an immediate retry — which is how a
capped budget gets spent twice over and the cap never fires.

Startup registers it or says why not, naming variables and never values.

### 11.5 Sending (was item 6) — and what `/api/outreach/preflight` is for

Still off. All seven flags false, `allExternalActionsDisabled` true. Turning it on is a decision
with real-world consequences and is not one this system should make for anybody.

What was missing was not the flag but the answer to the real question: *if I turned it on right
now, what would actually happen?* That answer lived across seven flags, an OAuth record, a DNS
posture, a settings document, a country table, a set of campaign guards and a basis on every
contact.

`GET /api/outreach/preflight` computes it. Eleven checks, each with what was found and what to do
about it. The design rule is that **a fact that could not be gathered is UNKNOWN, and UNKNOWN
BLOCKS** — every `catch` in the gathering service returns `null` rather than a falsy value,
because "the settings document could not be read" and "the settings document is empty" are
different facts and only one is fixed by filling in a form.

It also returns `uncheckable`: the four things it knows it cannot verify, named rather than
omitted, and returned on the ready path too. A caveat that disappears when everything passes is a
caveat nobody reads at the moment it matters.

Run live against the real database on 2026-09-15, it answered **10 blocking of 11** — including
reporting the sender-identity check as UNKNOWN because DNS could not be resolved in this
environment, which is precisely the case a two-state design would have rendered as a tick.

### 11.6 LinkedIn (was item 5) — still the owner's

The one that stays a decision. `docs/production/linkedin-decision.md` sets out four distinct
things that get called "LinkedIn lead generation", what each actually risks, and which I would
build. Summarised: the *hiQ* line of cases did not establish a right to scrape LinkedIn, the
breach-of-contract exposure is personal to whoever accepted the User Agreement, and a profile is a
much richer body of personal data than a contact page — which makes the balancing test harder, not
easier.

The recommendation is the Sales Navigator export path: a front door, ingested by the CSV importer
that already exists, with the source recorded as `IMPORT` like anything else. A day's work if the
owner wants it. If the owner wants profile scraping instead, it gets built — the decision is
theirs and the memo asks for it in writing, because a decision of that shape should exist
somewhere other than a conversation.

### 11.7 Proof

| | |
|---|---|
| Suites / tests | 103 / 2,672, exit 0 |
| New tests | 164 across six suites |
| Mutants | 96 across five batches, plus 5 controls — all behaving |
| Server bundle | 925.6 KB; client 1,330,798 bytes, no development markers |
| Code graph | 223 live modules, 0 dead |
| OpenAPI | 114 routes, 27 with a request contract |

**Six mutants survived the first run, and every one was closed by adding the test it exposed
rather than by arguing the mutant was equivalent.** Two were genuinely near-equivalent and were
still worth the test:

1. **A suppression flag cleared by the notice write.** Only reachable if the unsubscribe lands
   between the service's read and the transaction's re-read — which is exactly what happens when
   somebody clicks an opt-out link while a batch is running. The test reproduces the race in the
   mock dispatch.
2. **The gateway's own suppression check.** Unreachable in tests because the service's check
   caught the same case first. A guard only reachable once another guard has failed is a guard
   nothing is testing; it now has its own suite that exercises the executor rather than reading it.
3. **The gateway's opt-out refusal**, same shape.
4. **A coverage guard** reachable only on a malformed stored assessment — one whose `countries`
   list contains an empty string, which the validator strips but a migration or a hand edit could
   produce.
5. **Two discovery tests that reached the right outcome by the wrong route**: `__proto__.polluted`
   is undefined with or without the guard, and a huge body of `x` characters fails to parse
   whether or not the size check runs. Both were rewritten to be observable.

Two further notes, because they are the kind that get quietly dropped:

- **One mutant crashed and the harness refused to score it**, which is what the crash guard added
  in the previous session exists for. It turned out to be a malformed mutant of mine — unbalanced
  parentheses, so the suite failed to compile rather than to pass — and it was rewritten.
- **Two anchors stopped applying** when a guardrail (`check-no-verdict-arithmetic`) made me
  rewrite `count > 0 ? 'PASS'` as a presence check. They were repointed rather than left as a
  note in the output, which is the failure mode the previous session found.

Exercising the gateway executor rather than reading its source also turned up a real defect in my
own code: a notice body of three spaces passed the emptiness check, because it compared against
`''` without trimming.

### 11.8 What is left

One item, and it is the one that was always going to be left: **LinkedIn, A/B/C/D.**

Everything else in section 10 is now either enforced or drafted. Enforced means the system refuses
when the condition is not met. Drafted means a document exists and a person still has to read it
and sign it — the country review and the balancing assessment both sit there, and neither can be
completed by anybody who is not qualified to take responsibility for it.
