# Outreach rules: review pack

**For:** a solicitor or data protection adviser asked to check the jurisdiction rules this system
enforces before it sends any real email.

**What is being asked of you.** Not a research project. The system already encodes a reading of
each country's rules, and each reading names the instrument and provision it came from. What we
need is confirmation that each reading is right, and answers to the specific questions listed
under each country. Where a reading is wrong, changing it is a one-line edit — including moving a
country to "consent required", which the system already supports and which stops all outreach
there immediately.

**Who wrote the readings.** An engineer, not a lawyer, working from publicly stated regulator
positions and the text of the instruments cited. They are marked *settled* or *contested*
according to how confident that reading is, which is **not** a statement about whether anyone has
checked them. Nothing here has been checked. That is what this pack is for.

**What happens when you sign something off.** Each country carries a `review` field that is empty
today. Recording a name, a date and a matter reference against a country is what allows this
system to email anybody there once live sending is enabled. Until then the country refuses, with
the message "the rule recorded for GB has not been reviewed by a qualified person".

---

## 1. How the system behaves, in one page

This matters because several of your answers will be "it depends on X", and the useful follow-up
is whether the system can tell X.

**It refuses by default.** A country not in the table cannot be emailed. A contact with no country
cannot be emailed. There is no fallback jurisdiction; an earlier version of this code defaulted
unknown recipients to US rules, and that is the defect this design exists to prevent.

**Two lawful bases only.** Consent, and legitimate interests for business recipients. There is no
"soft opt-in" or existing-customer path implemented — if you think we should have one, that is a
feature request, not a configuration change.

**Legitimate interests requires all five of:**

1. a country whose regime permits it;
2. an address at an organisation — a free-mail address (gmail, outlook, yahoo and similar) is
   treated as an individual subscriber and refused, whatever the message says;
3. a *stated* address type, either `PERSONAL` (a named person, `jane@acme.example`) or `ROLE`
   (`info@acme.example`). Both are accepted; an unstated one is refused;
4. a signed balancing assessment that covers the contact's country and has not expired;
5. the Article 14 notice recorded as actually sent to that person.

**Consent requires** an affirmative record, free-text evidence of where and when it was given, and
a named person who recorded it. A revocation outranks a later consent unless somebody explicitly
acknowledges the revocation when re-recording.

**Suppression outranks everything.** An unsubscribe, a spam complaint or a hard bounce blocks all
mail including the Article 14 notice. We take the view that a duty to inform does not override
somebody having told us to stop, and that the honest remedy for a lead we may not contact is to
delete the record. **Question for you: is that right, or must the notice go out regardless?**

**What we hold.** Work email address, name where we have it, job title, employer name, employer
website, industry, employee-count band, country, and free-text notes. No special category data is
collected or stored. Source and collection date are recorded per contact and are what the Article
14 notice quotes.

**How data is obtained.** Four routes, all recorded per contact: a CSV import, a paid data
provider (no provider is currently connected), a scraper that reads company websites and obeys
robots.txt, and manual entry. LinkedIn is **not** scraped — see `linkedin-decision.md`.

---

## 2. The countries, and what we need answered

### United Kingdom (`GB`) — treated as: legitimate interest available for corporate subscribers

*Confidence: settled.*

**What the system does.** Business recipients at incorporated entities may be emailed on a
legitimate interests basis, subject to the five conditions above and an absolute right to object.

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| PECR 2003 | reg. 22 | No unsolicited marketing email to an *individual subscriber* without prior consent, subject to the soft opt-in in reg. 22(3). |
| PECR 2003 | reg. 2(1) | Defines "individual" to include a sole trader and an unincorporated body of persons. |
| UK GDPR | Art. 6(1)(f) | Legitimate interests, subject to the balancing test. |
| UK GDPR | Art. 21(2) | Absolute right to object to direct marketing. |
| UK GDPR | Art. 14(1)–(3) | Information to be provided where data were not obtained from the data subject: within a month, or at first communication if earlier. |

**Please confirm:**

1. A **named employee at a limited company** is a corporate subscriber for reg. 22 purposes, so
   both `PERSONAL` and `ROLE` addresses are reachable. If a named individual's work address is
   treated differently, we need to know, because the system currently treats them identically.
2. **LLPs.** A body corporate, but often discussed alongside partnerships. The system cannot
   currently distinguish an LLP from a limited company. If they differ, we need a new field and a
   refusal for the unknown case — tell us and we will build it.
3. **Sole traders and unincorporated partnerships** need consent. We have no reliable way to
   detect them from an email address or a website. Is "we may email a sole trader by mistake"
   acceptable with a prompt suppression process, or do we need a positive check before any UK
   send?
4. **The notice itself.** We send the Article 14 notice as a standalone email before any
   marketing. Is that acceptable, and is it itself direct marketing for PECR purposes? If it is,
   the design does not work and we need to know now.

---

### United States (`US`) — treated as: opt-out

*Confidence: settled.*

**What the system does.** No prior permission required. Every message carries a working
unsubscribe link and suppression is immediate.

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| CAN-SPAM Act 2003 | 15 U.S.C. 7704(a) | No false or misleading headers or subject lines; requires a functioning return address, clear opt-out, and the sender's physical postal address in each commercial message. |
| CAN-SPAM Act 2003 | 15 U.S.C. 7704(a)(4)(A) | Opt-out honoured within ten business days. |
| FTC CAN-SPAM Rule | 16 C.F.R. Part 316 | Primary-purpose test; treatment of transactional messages. |

**Please confirm:**

1. **The postal address.** The system refuses to send until a physical postal address is
   configured, and puts it in the footer. Confirm which address we are entitled to use.
2. **State law.** Is there any state whose law adds a consent requirement we should care about?
   If so we need state-level rows rather than one US row, which is a build change.
3. **Immediate suppression** is stricter than ten business days, but the claim should be checked
   against how the unsubscribe endpoint actually behaves rather than against our intent. Happy to
   demonstrate it.

---

### Germany (`DE`) — treated as: consent required

*Confidence: settled.*

**What the system does.** Legitimate interest is unavailable. Only a recorded consent permits a
German send.

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| UWG | § 7(2) no. 2 | Advertising by email without prior express consent is an unreasonable nuisance. No business/consumer distinction. |
| UWG | § 7(3) | Narrow existing-customer exception for similar goods, with objection rights at collection and in every message. |

**Please confirm:**

1. That we should **not** attempt the § 7(3) existing-customer exception. The system has no
   reliable record of who is an existing customer, so implementing it would mean guessing, in the
   permissive direction. We would rather not.
2. **What form of consent record suffices.** We store free-text evidence plus a named recorder.
   If a German court expects a double opt-in with a logged confirmation, our record is weaker
   than it needs to be and we should build that.

---

### Canada (`CA`) — treated as: consent required

*Confidence: settled.*

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| CASL, S.C. 2010, c. 23 | s. 6(1) | No commercial electronic message without express or implied consent; must identify the sender and carry an unsubscribe mechanism. |
| CASL, S.C. 2010, c. 23 | s. 10(9)(b) | Implied consent where the recipient conspicuously published their address without a statement refusing such messages, and the message is relevant to their role. |

**Please confirm:**

1. That we should **not** rely on s. 10(9)(b). It is the provision a scraper is most tempted by,
   and relying on it means proving a negative — that no statement refusing such messages was
   present on the page. The scraper does not currently capture that, and we would rather build
   the evidence capture than assume it.
2. If you think the provision **is** available to us: confirm what would have to be captured and
   retained as evidence — the page as fetched, the date, and the absence of a refusal statement.
   That is a feature we would build, not a flag we would set, and we would rather build it than
   rely on the exemption without it.

---

### Netherlands (`NL`) — treated as: legitimate interest available for corporate subscribers

*Confidence: **contested**. This is the row we are least sure of.*

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| Telecommunicatiewet | Art. 11.7 | Restricts unsolicited electronic communications for commercial purposes without prior consent; covers legal persons as well as natural persons, with exemptions including an address published by the subscriber for that purpose. |
| GDPR | Art. 6(1)(f), Art. 14 | As elsewhere in the EU. |

**Please answer:**

1. Does the **published-address exemption** actually cover a scraped `info@` address on a company
   website, or does it require something closer to an explicit invitation to be contacted?
2. If it does not, **move the Netherlands to consent required.** No code change is needed and no
   Dutch contact becomes mailable until somebody records a consent.
3. Does the legal-person extension change the analysis for a **one-person BV**?

---

### France (`FR`) — treated as: legitimate interest available for professional recipients

*Confidence: **contested**.*

**Derived from:**

| Instrument | Provision | What it says |
|---|---|---|
| Code des postes et des communications électroniques | Art. L.34-5 | Prohibits direct marketing email to a natural person without prior consent, with an exception where the person is contacted in a professional capacity about something relevant to that capacity. |
| CNIL published position on B2B prospecting | guidance | A professional may be contacted without prior consent where the message concerns their professional role, provided they were informed when their address was collected and can object at collection and in every message. |

**Please answer:**

1. The exception turns on the message **relating to the recipient's professional role**. What
   makes that true in practice, and should the system be enforcing it rather than leaving it to
   whoever writes the copy? We can enforce very little about copy, and would rather say so than
   imply otherwise.
2. A **generic role address** such as `contact@` has at times been treated as not personal data
   at all. If that reading holds, `ROLE` and `PERSONAL` differ in France and the row should split.
3. The exception requires informing the person **at the time of collection**. We inform them
   afterwards, by the Article 14 notice. If that does not satisfy it, France is unreachable for
   scraped data and the row should move to consent required.

---

## 3. What we are not asking you to check

Stated plainly so that a sign-off is not read as covering more than it does.

- **Whether the balancing assessment is any good.** The system checks that each limb of the
  three-part test is present and long enough to be a sentence. It cannot check that the reasoning
  is sound. The draft assessment is in `lia-uk-b2b-2026.md` and would benefit from your eye, but
  that is a separate ask.
- **Whether the people on a list are the right people to contact.** A business judgement.
- **Whether the message copy is accurate or would be read as deceptive.** Nothing in the system
  reads the copy.
- **Whether a recorded sign-off was a good one.** The `review` field records that somebody
  reviewed a row. Nothing can verify the quality of that review, and the system does not pretend
  to.

---

## 4. How to record your answers

For each country you are content with, we need three things: **who** reviewed it (you or your
firm), **when** (the date of the advice), and **a matter or file reference** somebody could
produce on request. All three are required — a sign-off nobody can trace is treated by the system
as no sign-off at all.

Send them in whatever form is convenient; we will record them in
`server/domain/lawfulBasisSources.ts` and the corresponding country will stop refusing.

Where you want a row **changed** rather than signed off, say which regime it should be. Moving a
country to consent-required takes effect immediately and makes every existing legitimate-interest
contact there unmailable, with no data lost.
