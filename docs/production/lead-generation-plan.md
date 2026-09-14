# Lead generation: the plan

**Status: proposed, not started.** Written 2026-09-15 against commit `dde849d`.

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
