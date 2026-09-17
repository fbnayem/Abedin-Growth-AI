# Legitimate interests assessment — LinkedIn-identified contacts, 2026

**For:** whoever is going to sign this. That person takes responsibility for the balancing
judgement below, so it is written to be argued with rather than nodded at.

**Status: DRAFT. Not signed. Not in force.**

This is the second assessment. `docs/production/lia-uk-b2b-2026.md` covers people whose contact
address we collected from their own organisation's website, or from a list, or by hand. It does
**not** cover people identified on LinkedIn, and as of this change the system enforces that
rather than merely stating it: a contact whose `source` is `LINKEDIN` cannot cite the other
document, and will be refused with `LIA_SOURCE_NOT_COVERED`.

So this document has to exist before any LinkedIn-identified person can be emailed, and it is
genuinely a different argument rather than the same one with a word changed. The differences are
in Limb 2 and Limb 3, and they are the reason the split was worth making.

**How to put it into force.** Nothing here has effect as a document. The system only recognises an
assessment that is stored and signed:

1. `POST /api/lia` with the fields below.
2. Read it properly. Change what is wrong. Limb 3 in particular.
3. `POST /api/lia/:id/sign`. The signer is taken from your credential, not from a field, and the
   text is frozen at that moment.
4. The returned `id` goes on each LinkedIn-sourced contact as `liaId`.

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
| **Supersedes** | Nothing. First assessment for this route. |
| **Review due** | Twelve months after signature, unless a shorter date is given at signing |
| **Countries covered** | `GB` |
| **Routes covered (`sourceKinds`)** | `LINKEDIN` only |
| **Address routes covered (`addressSourceKinds`)** | `INFERRED_PATTERN`, `EMPLOYER_WEBSITE`, `MANUAL_RESEARCH` — explicitly **not** `PROVIDER` |
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

Outreach to UK business contacts identified from LinkedIn profiles, 2026

## Countries covered

`GB` only.

Same reasoning as the other assessment: the balancing test is not the same in every jurisdiction,
and one covering "Europe" covers nothing in particular. Note that the country recorded for a
LinkedIn-identified contact is a weaker fact than for a scraped one — a profile's stated location
is self-reported and may be where the person lives rather than where they work. If that matters
to you, the safeguard is to refuse contacts whose country came only from a profile, and that is a
change to make before signing rather than after.

## Routes of acquisition covered

**How the person was identified (`sourceKinds`):** `LINKEDIN` only.

**How the address was obtained (`addressSourceKinds`):** `INFERRED_PATTERN`, `EMPLOYER_WEBSITE`,
`MANUAL_RESEARCH`.

**Not `PROVIDER`.** A purchased address is a different chain of collection with somebody else's
notice obligation in it, and this document does not make that argument. It is also blocked in
code: an assessment declaring it is refused at authoring time.

Two lists because they are two different acts. LinkedIn tells us **who**; it does not publish the
address. Somebody then has to obtain one, and how they did it is the fact the necessity limb below
turns on.

## The two facts this assessment must not lose

These are the two things that make this route different from the scraped-website one. They are
the reason a separate assessment exists, they are what the balancing limb below turns on, and
they are singled out here so that a later revision cannot quietly drop them while keeping the
signature.

**1. The email address was not published on LinkedIn.**

The profile is public. The address is not on it. Somebody had to obtain it elsewhere — and that is
a step the person took no part in and did not invite. Every argument in Limb 2 and Limb 3 is
downstream of this one fact, and an assessment that stopped mentioning it would be describing the
scraped-address case under a different title.

*How the system holds it:* a prospect record has **no email field at all** — supplying one is a
refusal rather than an ignore. The address arrives only at promotion, as a separate act, and
`emailSource` records where it came from and is **required**. The Article 14 notice says it to the
person in as many words: "we found your work email address separately".

**2. The profile relates to an individual, not an organisational inbox.**

A scraped contact is usually `info@` at a business — an organisational mailbox, read by whoever is
on duty. A LinkedIn contact is a named person, and the message lands in the mailbox they read.
The legal category is the same, a corporate subscriber; the data protection weight is not. This is
the principal reason the balance here is closer than in the other assessment.

*How the system holds it:* `addressType` is recorded per contact and an unstated one is refused
outright — `LI_ADDRESS_TYPE_UNKNOWN` — so the category of personal data being processed is always
a known fact rather than an assumption. Note that it is **not** forced to `PERSONAL` for this
route: a profile can legitimately lead to a role inbox, and pretending otherwise would put a
falsehood in the record. What is guaranteed is that somebody stated which it is.

### Fact 1 is now mechanical — what used to be a gap here

This section used to record an admission: that `sourceKinds` checked how the person was identified
while `emailSource` recorded how the address was obtained as free text, so a contact identified on
LinkedIn whose address had been **bought** would still pass under this assessment. The gate could
not tell it apart from one whose address came from the employer's own site.

That is closed. The address route is now a closed vocabulary of its own
(`server/domain/addressSource.ts`), declared by this document above, stored per contact, and
checked at the gate alongside the country and the person route. A purchased address on a
LinkedIn-identified contact is refused by name, with `LIA_ADDRESS_SOURCE_NOT_COVERED`.

Three things follow, and the third is a limitation worth stating:

- **Limb 2's distinction is enforced rather than promised.** Where it says this assessment covers
  a derived address and not a purchased one, the software now agrees.
- **Promotion cannot record an address without saying how it was obtained.** Both the kind and the
  evidence are required, and the service refuses without them rather than relying on the request
  contract to have run.
- **The three dimensions are read as a cross-product.** An assessment declaring two person routes
  and three address routes is treated as covering all six combinations. This document declares one
  person route, so the question does not arise here — but if a future assessment needs a
  particular pairing and not another, the remedy is two documents with one route each, not a
  cleverer field.

## Limb 1 — the purpose test: what is the interest, and whose?

Ours, commercially: to introduce our services to businesses that plausibly need them, at a cost
that makes approaching them worthwhile at all.

It is a legitimate interest and it is an ordinary one. Direct marketing is named in Recital 47 of
the UK GDPR as capable of being a legitimate interest, which settles that the interest qualifies
and settles nothing about whether it wins — that is Limb 3.

What is specific to this route: LinkedIn is where we can identify the *role* rather than the
*mailbox*. A practice website gives us `info@`; a profile gives us the person who actually makes
the decision. The interest in reaching a decision-maker rather than a shared inbox is real and it
is also, honestly, an interest in a more effective approach — which is worth stating plainly
because it is a point against us in Limb 3, not for us.

## Limb 2 — the necessity test: why is this processing needed?

This limb is harder here than in the other assessment, and it should be read carefully.

For a scraped contact, necessity is close to trivial: the organisation published an address for
the purpose of being contacted, and using it is the only way to take up the invitation. Nothing
less intrusive reaches the same end.

Here, the address is **not** published. The profile is. To email the person we have to:

1. identify them from a public profile, and
2. obtain a work email address from somewhere that is not the profile — a pattern inferred from
   the employer's domain, a third-party lookup, or a colleague's published address.

Step 2 is the one that needs justifying, and there are two honest answers depending on how it is
done:

- **Inferred from a published pattern.** If `firstname.lastname@employer.example` is the visible
  convention on the employer's own site, then the address is derived from published information
  about the organisation rather than about the person. This is the defensible version, and it is
  the only one this system should perform.
- **Bought from a data provider.** Then the record is a purchased record, and the provider's own
  collection and notice obligations are in the chain. **This assessment does not cover that**, and
  that exclusion is now enforced in both directions. Where the PERSON was found through a provider
  the route is `PROVIDER:<name>` and no assessment may cover it; where the person was found on
  LinkedIn and only the ADDRESS was purchased, the address route is `PROVIDER` and no assessment
  may cover that either. Both are recorded policy decisions rather than omissions, and both refuse
  by name.

Could we reach the same end less intrusively? Two alternatives deserve an answer:

- **LinkedIn's own messaging.** It reaches the person without an email address at all. It is
  rejected here for a reason that is not about privacy: this system cannot attach an opt-out it
  controls to a LinkedIn message, and every send path in it refuses when it cannot. See
  `docs/production/linkedin-decision.md`.
- **Advertising and inbound forms.** These reach people who chose to respond, and they are
  genuinely less intrusive. They are also not a substitute at the volumes involved. If LinkedIn
  Lead Gen Forms are adopted, those contacts arrive under CONSENT and do not need this document
  at all — which is a point in favour of doing that instead, and is recorded as such.

The processing is limited to what the approach requires: name, role, employer, and a work address.
No connection graph, no activity, no inferred attributes, nothing scraped from the profile beyond
what identifies the person and their job.

## Limb 3 — the balancing test: against the person's interests, rights and freedoms

**This is the limb that decides it, and it is weaker here than in the other assessment. Two
places are genuinely uncomfortable and are named rather than argued around.**

### What is in our favour

- The context is professional throughout. The profile is published for professional purposes, the
  employer is stated on it, and the message concerns the person's work.
- The data is low-sensitivity: name, job title, employer, work address. No special category data,
  no financial data, nothing about the person's private life.
- LinkedIn profiles are public by the member's own choice, and a great many members set them
  public *in order to* be approached — by recruiters, by suppliers, by peers.
- The impact of one unwanted email is small and reversible, and it is reversed on the first word
  of objection, permanently, outranking every basis.
- The Article 14 notice goes out first, and for this route it says the two things that are
  actually true and unusual: that we found them on a public profile, and that we found the
  address **separately**. A person who objects to the second step is told about the second step
  before we use it.

### What is against us, without softening

- **The address was not published, and that is the whole difficulty.** The other assessment rests
  on an invitation: an organisation published a contact route. Here there is no invitation. The
  person published who they are; somebody else worked out how to reach them. A reasonable person
  may well distinguish "I made my profile public" from "I agreed to be emailed at work", and it
  is not obvious they would be wrong.
- **A profile is a person; a practice inbox is an organisation.** A `SCRAPE` contact is usually
  `info@` at a business. A LinkedIn contact is a named individual, and the message arrives at
  their personal work mailbox. The data protection weight is higher even though the legal
  category (corporate subscriber) is the same.
- **LinkedIn's terms are a separate question from this one.** Identifying people from profiles at
  scale, by automated means, is restricted by LinkedIn's User Agreement. That is a contractual
  matter and not a data protection one, and this assessment does not resolve it. It is recorded
  here because a signer who reads only this document should not come away thinking the route is
  settled. See `docs/production/linkedin-decision.md`.
- **PECR applies to the send regardless.** The recipient is a corporate subscriber and the B2B
  route stands, but the assessment being about LinkedIn does not change what PECR requires of the
  message itself.

### The conclusion being proposed

That the balance is **capable** of being struck in our favour for a named individual at a
business, contacted once, about their work, with the notice sent first and an immediate and
permanent opt-out — and that it is closer than the scraped-address case and should be treated as
such.

Two conditions are proposed as part of the balance rather than as extras, and the signer should
decide whether they are enough:

1. **The address must be derived from published organisational information, not purchased.** A
   purchased address is a different route with a different chain, and this document does not
   cover it.
2. **One approach, not a sequence.** Where the address itself was inferred, a follow-up to
   silence is harder to defend than it is for a published address, because silence may mean the
   inference was wrong and the message went to a stranger.

## Data categories

- name
- job title or role
- employer name
- employer website
- LinkedIn profile URL, as the record of where the person was identified
- work email address, obtained separately
- how the address was obtained, recorded per contact
- country, as stated on the profile
- free-text notes recorded by our team

## Data sources

- public LinkedIn profiles, recorded as the profile URL the person was identified at
- work email addresses derived from the employer's own published address convention

The machine-checkable version of this list is **Routes of acquisition covered**, above: `LINKEDIN`
alone. Both are required; neither substitutes for the other.

## Safeguards

- suppression on first objection, applied immediately and permanently, and outranking every
  lawful basis
- an unsubscribe link in every message, and the system refuses to send when one cannot be built
- the Article 14 notice sent before any marketing message, in wording specific to this route —
  it says the profile was public and the address was found separately
- the profile URL retained on the contact, so the notice can say where the person was identified
  rather than gesturing at "public sources"
- free-mail addresses refused outright
- no special category data, no connection graph, no activity data, no profiling
- one approach, not a sequence
- records deleted on request, and on the retention schedule in the other assessment

## How a person objects

> Reply to any message from us and say so, or email privacy@abedin.example, or use the unsubscribe
> link in any message. We will remove the record and not contact that person again. We do not ask
> for a reason and we do not ask you to confirm twice.

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
- **The source sentence for LinkedIn specifically.** “We identified you from your public LinkedIn profile, recorded as <the profile URL>, and found your work email address separately. Neither was given to us by you.” Both halves are deliberate — see § The two facts this assessment must not lose.
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
| A prospect with no address found | 6 months, then deleted | A prospect is a person we have identified and cannot email. Holding one indefinitely on the chance an address turns up is not a purpose. |
| Evidence a notice was sent | Life of the contact record plus 2 years | It is the proof the Article 14 obligation was met. |
| This assessment, signed | Indefinitely | It is the record of what rules the system operated under, and when. |

The middle row is the one worth arguing about: a suppression record is personal data kept forever
in order to protect the person it concerns. Minimising it to a hash and a date is the answer this
document proposes, and it is the approver's to accept.

## Review

Twelve months from signature, which the system applies by default.

Sooner if any of these change: LinkedIn's User Agreement as it bears on identifying members; the
ICO's position on B2B direct marketing; or the way addresses are obtained — in particular, if a
data provider is ever used, this assessment does not stretch to cover it.

## Signature

Not signed. The system will refuse every LinkedIn-sourced contact citing this document until it
is, and will name it as `LIA_UNSIGNED` rather than failing quietly.
