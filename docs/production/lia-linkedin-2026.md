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

`LINKEDIN` only.

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
  collection and notice obligations are in the chain. **This assessment does not cover that.**
  Such a contact's `source` would be `PROVIDER:<name>`, which is a different route and needs a
  third assessment. That is a consequence of the route field, and it is the intended one.

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

## Review

Twelve months from signature, which the system applies by default.

Sooner if any of these change: LinkedIn's User Agreement as it bears on identifying members; the
ICO's position on B2B direct marketing; or the way addresses are obtained — in particular, if a
data provider is ever used, this assessment does not stretch to cover it.

## Signature

Not signed. The system will refuse every LinkedIn-sourced contact citing this document until it
is, and will name it as `LIA_UNSIGNED` rather than failing quietly.
