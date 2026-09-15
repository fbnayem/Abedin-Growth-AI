# Legitimate interests assessment — UK B2B outreach, 2026

**For:** whoever is going to sign this. That person takes responsibility for the balancing
judgement below, so it is written to be argued with rather than nodded at.

**Status: DRAFT. Not signed. Not in force.**

This is a starting point, not an assessment. It was drafted by the engineer who built the system,
which means it is accurate about what the system does and unqualified about whether the balance
below is correctly struck. Read it as a proposal from the person who knows the mechanics, to the
person who owns the risk.

**How to put it into force.** Nothing here has effect as a document. The system only recognises an
assessment that is stored and signed:

1. `POST /api/lia` with the fields below — or paste them into the Lead Sources console.
2. Read it properly. Change what is wrong.
3. `POST /api/lia/:id/sign`. The signer is taken from your credential, not from a field, and the
   text is frozen at that moment.
4. The returned `id` goes on each contact as `liaId`. Contacts citing an unsigned draft are
   refused.

Once signed it cannot be edited. If it is wrong, withdraw it and write another — which takes
effect immediately and makes every contact citing it unmailable, with no data lost.

---

## Document control

Every field here is on the reviewer's checklist. A blank one is a blank one — it is not filled in
with a plausible value, because a document control block that invents its own approver is worse
than one that admits it has none.

| Field | Value |
|---|---|
| **Owner** | _(unassigned — the person accountable for this document being correct and current)_ |
| **Reviewer / approver** | _(unassigned — must be the privacy or legal reviewer, and must not be the author)_ |
| **Author** | Drafted in the Abedin Growth AI repository by the engineer who built the enforcement. Accurate about what the system does; unqualified on whether the balance is correctly struck. |
| **Version** | 1 |
| **Status** | **DRAFT — not signed, not in force** |
| **Effective from** | _(set at signature)_ |
| **Supersedes** | Nothing. First assessment for these routes. |
| **Review due** | Twelve months after signature, unless a shorter date is given at signing |
| **Countries covered** | `GB` |
| **Routes covered (`sourceKinds`)** | `SCRAPE`, `IMPORT`, `MANUAL` — **not** `LINKEDIN`, **not** `PROVIDER` |
| **Article 14 handling** | § Article 14 handling, below |
| **Retention** | § Retention, below |
| **Objection route** | § How a person objects, below |

**What the system can and cannot record about this approval.** When signed, it stores the signer,
the signature timestamp, the review date, the frozen text, and the exact `sourceKinds`. It does
**not** yet store a content hash, a separate effective date, or a link to a superseded version.
Those three are on the reviewer's list and the software cannot preserve them today — so they must
be built before a signed assessment is loaded, not after, or the evidence is lost at the moment it
is created. Flagged rather than worked around.

---

## Title

UK B2B outreach to dental and healthcare practices, 2026

## Countries covered

`GB` only.

This is deliberate. The balancing test is not the same in every jurisdiction, and an assessment
covering "Europe" covers nothing in particular. A second country needs its own assessment, or a
considered extension of this one.

## Routes of acquisition covered

`SCRAPE`, `IMPORT`, `MANUAL`.

**Not** `LINKEDIN`, and **not** `PROVIDER`.

This is a new field and it is worth saying why it exists, because it looks like a duplicate of
"data sources" below and is not. `dataSources` is prose, written for you and for a regulator.
`sourceKinds` is a closed list the system can check: every contact carries a `source`, and before
a send the gate asks whether THIS assessment covers THAT route. Until this field existed the gate
only checked the country, so an assessment covering `GB` covered every `GB` contact however we
had found them — and this document, which is about addresses practices publish on their own
websites, would have been cited for a person identified on LinkedIn.

The distinction is not administrative. The balancing limb below turns on what the person
reasonably expected when they published their details. Somebody who put a contact address on
their practice's own website, for the purpose of being contacted about the practice, expected
something quite specific. Somebody who put up a professional profile and never published an
address did not, and there is an extra step — finding the address elsewhere — that they took no
part in. Those are two arguments. This document makes one of them.

`PROVIDER` is excluded for the same reason it is flagged under Data sources: a purchased record
carries a weaker expectation and a chain of collection we did not see. If a provider is ever
connected, that is a new assessment, not an amendment to this one.

## Limb 1 — the purpose test: what is the interest, and whose?

> Our own commercial interest in finding businesses that may need what we sell, and in reaching
> the person at that business who would decide. We sell practice-management software to dental
> and healthcare practices in the United Kingdom. The interest is straightforward and it is ours:
> we want to sell things, and direct approach to the relevant decision-maker is how business
> software is sold at this size of customer. We claim no public interest and no benefit to the
> recipient beyond the possibility that the product is useful to them. The Information
> Commissioner recognises direct marketing as capable of being a legitimate interest, and that is
> the interest relied on here, stated plainly rather than dressed up as something else.

*Note for the signer: the temptation here is to write "we help practices improve patient
outcomes". Resist it. An inflated purpose makes the balancing test harder to pass, not easier,
because the claimed benefit is then weighed against what you actually do.*

## Limb 2 — the necessity test: why is this processing needed?

> We need a name, a work email address, a job title and an employer in order to approach the right
> person at a business we believe may need the product. There is no less intrusive route to the
> same end that we can identify: advertising and inbound marketing reach a different and much
> smaller set of practices, and a generic switchboard approach reaches somebody who cannot make
> the decision and wastes their time as well as ours. We process no more than is needed to
> identify the business, identify the right role within it, and make contact once. We do not
> profile individuals, infer anything about them personally, or enrich the record with data about
> them outside their professional role.

*Note for the signer: if you disagree that this is necessary — if inbound alone would do — then
the basis fails at this limb and no amount of balancing rescues it.*

## Limb 3 — the balancing test: against the person's interests, rights and freedoms

> **What the person would reasonably expect.** The recipient is contacted at a work address, about
> their work, by a supplier of something their business plausibly uses. Business people expect to
> be approached by suppliers. The expectation is weaker where we obtained the address by scraping
> a website than where they handed it over, which is exactly why the Article 14 notice is sent
> before any marketing message rather than alongside it.
>
> **The impact on them.** Low but not nil. It is one unsolicited email, plus a notice telling them
> we hold their details. The data is their work contact details, which are in most cases already
> published by their employer. We hold no special category data, nothing about their private life,
> and nothing they have not already made available in a professional context.
>
> **Where the balance is uncomfortable.** Two places, stated because an assessment that finds no
> tension has not been performed.
>
> First, a **named individual** at a practice (`jane@practice.example`) has a stronger interest
> than a role address (`info@practice.example`). It is personal data about an identified person,
> and she did not choose to hear from us. We accept that and rely on the low impact, the
> professional context, and the absolute right to object — but a signer who thinks named
> individuals should be excluded entirely can say so, and the system supports restricting to
> `ROLE` addresses.
>
> Second, **healthcare practices** are not an ordinary commercial audience. We hold nothing about
> patients and nothing clinical, and our contact is with the practice as a business — but the
> sector deserves the note rather than being waved through as "B2B".
>
> **The conclusion.** On balance we consider the interest is not overridden, for corporate
> subscribers, on these safeguards, for one approach and no more. We do not consider it justified
> for sole traders or unincorporated partnerships, who are individual subscribers under PECR and
> whom this system refuses to email on this basis.

*Note for the signer: this is the limb that decides it, and it is the one most often written as an
assertion. If you are not persuaded, do not sign it.*

## Data categories

- work email address
- name, where published
- job title or role
- employer name
- employer website
- industry
- employee-count band
- country
- free-text notes recorded by our team

## Data sources

- company website contact pages, collected by our own crawler, which obeys robots.txt and
  identifies itself
- CSV lists imported by our team, with the source recorded per import
- manual entry by our team, with the origin recorded
- (not currently used) a paid data provider — if one is ever connected, this assessment needs
  revisiting, because a purchased list carries a weaker expectation than a published address
- (not covered here) LinkedIn profiles — covered by its own assessment,
  `docs/production/lia-linkedin-2026.md`, because the expectation attaching to a published
  profile is materially different from the one attaching to a published address

The machine-checkable version of this list is **Routes of acquisition covered**, above. Both are
required; neither substitutes for the other.

## Safeguards

- suppression on first objection, applied immediately and permanently, and outranking every
  lawful basis
- an unsubscribe link in every message, and the system refuses to send when one cannot be built
- the Article 14 notice sent before any marketing message, naming the actual source of the record
- free-mail addresses refused outright, so we do not reach individuals at personal addresses
- no special category data collected or stored
- no profiling and no automated decision-making about individuals
- one approach, not a sequence, unless the person replies
- records deleted on request, and on the retention schedule below

## How a person objects

> Reply to any message from us and say so, or email privacy@abedin.example, or use the unsubscribe
> link in any message. We will remove the record and not contact that person again. We do not ask
> for a reason and we do not balance the request against anything — for direct marketing the right
> to object is absolute.

*Configure the real address in organisation settings before signing. The system will not send a
notice until the controller details are complete, and the placeholder above will read as a
placeholder to whoever receives it.*

## Article 14 handling

Article 14 applies to every record here, because none of it was obtained from the person
themselves. The system treats the notice as a precondition rather than a policy: a contact with no
`article14NoticeSentAt` is refused at the gate with `LI_NOTICE_NOT_SENT`, and that refusal cannot
be bypassed by a setting.

- **What is sent.** A notice naming the controller, the source of the record in terms the person
  can picture, the categories held, the basis and this assessment's id and signature date, the
  retention statement, the rights, and how to object. Built by
  `server/domain/article14Notice.ts`; it refuses to build at all if any controller field is
  missing, rather than emitting a notice with a gap in it.
- **When.** Before or with first contact. Mechanically: the notice send is a separate action type
  through the gateway, and the marketing send stays refused until it has succeeded.
- **The source sentence for a scraped address specifically.** “We collected it from a publicly accessible web page: <the page>. It was not obtained from you directly.” An imported record and a manually entered one each get their own sentence naming the file or the person.
- **If the send is ambiguous** — a provider timeout, an unreadable response — the contact is
  marked ambiguous and stays unmailable. The notice is never recorded as sent on a maybe, because
  recording "sent" when it was not marks somebody mailable who was never told where we got their
  data. A duplicate notice is the harmless direction.
- **What is NOT automated.** A person exercising a right in reply to the notice — access,
  rectification, erasure — is handled by a human reading the mailbox. Objection and unsubscribe
  are the exceptions and are mechanical.

## Retention

**Nothing in the system enforces any of this today.** The `retentionPolicy` controller setting is
a sentence an operator writes, and it is quoted verbatim to the recipient under "HOW LONG WE KEEP
IT". There is no deletion job. That makes the schedule below a commitment made to people in
writing and kept by hand, which is exactly the shape of control this repository exists to remove
— it is recorded here as an open gap rather than presented as a safeguard.

Proposed, for the approver to accept or change:

| Record | Kept for | Why |
|---|---|---|
| A contact who never replied | 12 months from last contact, then deleted | Past that, the record is neither a live prospect nor evidence of anything. |
| A contact who replied or became a customer | Per the ordinary customer record, outside this assessment | Different purpose, different basis. |
| A contact who objected or unsubscribed | **Indefinitely, minimised**: address hash, date, and that they objected. Nothing else. | Required to honour the objection. Deleting it would let the same person be re-imported and contacted again, which is the harm the objection exists to stop. |
| A prospect with no address found | 6 months, then deleted | Not reachable by these routes; included so the table is the same in both assessments. |
| Evidence a notice was sent | Life of the contact record plus 2 years | It is the proof the Article 14 obligation was met. |
| This assessment, signed | Indefinitely | It is the record of what rules the system operated under, and when. |

The middle row is the one worth arguing about: a suppression record is personal data kept forever
in order to protect the person it concerns. Minimising it to a hash and a date is the answer this
document proposes, and it is the approver's to accept.

## Review

Due twelve months after signature, or immediately on any of:

- a change to the outreach regime recorded for GB;
- a data provider being connected;
- a complaint or a regulator contact;
- the audience widening beyond UK dental and healthcare practices.

## Signature

Recorded by the system, not by this document. The signer's identity comes from their credential
at `POST /api/lia/:id/sign`; the date is the moment of signing; and the text is frozen at that
point. A name typed into this file is not a signature and the system will not treat it as one.
