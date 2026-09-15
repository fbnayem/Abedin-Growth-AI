/**
 * THE COUNTRY TABLE, AND WHAT EACH ROW IS DERIVED FROM (§14).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The table used to live in `lawfulBasis.ts` as six entries, each a regime and a sentence of
 * prose, under a comment reading "THIS TABLE NEEDS LEGAL REVIEW BEFORE IT IS RELIED ON". That
 * comment was true, and it was also the whole of the control: nothing stopped a seventh country
 * being added with no source, and nothing anywhere could tell a reviewed row from an unreviewed
 * one. A rule that lives only in a comment will be forgotten, which is the argument this
 * repository makes about every other rule it has moved into code.
 *
 * So the citation IS the row. `CountryRule` requires at least one `LegalSource` — an instrument,
 * a provision, and what that provision actually says — and TypeScript refuses a row without one.
 * Adding a country is now, mechanically, an act of citing something.
 *
 * WHAT `review` MEANS, AND WHAT IT GATES
 * --------------------------------------
 * `review: null` means no qualified person has signed off this row. Every row is null today,
 * because none has been. That is not a placeholder to be filled in by whoever next edits the
 * file: `RegimeReview` asks for a name, a date and a reference somebody could look up, because
 * a sign-off nobody can trace is the same as no sign-off.
 *
 * An unreviewed row still works in development — otherwise nothing could be built against it.
 * What it cannot do is send real email. `evaluateLawfulBasis` takes a `requireReviewedRegime`
 * option, the gateway passes it whenever `REAL_EMAIL_SEND_ENABLED` is on, and an unreviewed
 * country then refuses with `COUNTRY_NOT_LEGALLY_REVIEWED`. The sharp edge is at the flag:
 * turning real sending on cannot silently begin mailing people under a rule nobody checked.
 *
 * WHAT THE PROSE BELOW IS AND IS NOT
 * ----------------------------------
 * It is a reading of publicly stated positions, written by someone who is not a lawyer, to be
 * checked by someone who is. `confidence` says which rows read as settled and which are
 * genuinely contested, and `openQuestions` names the specific thing each row needs answered —
 * so the review is an afternoon of confirming particulars rather than a research project.
 * `docs/production/legal-review-pack.md` is the same content written for that reader.
 *
 * DO NOT read a `SETTLED` marker as legal advice. It marks how confident the reading is, not
 * whether it has been checked. Only `review` says that, and only a person can set it.
 */

/**
 * How a country treats unsolicited commercial email.
 *
 *   GDPR_LI           legitimate interest is available for business recipients, with a right
 *                     to object that must be honoured.
 *   OPT_OUT           no prior permission required, subject to the local regime's own rules
 *                     (accurate headers, a postal address, a working unsubscribe).
 *   CONSENT_REQUIRED  prior express permission, including for business recipients.
 */
export type OutreachRegime = 'GDPR_LI' | 'OPT_OUT' | 'CONSENT_REQUIRED';

/** One thing a rule is derived from, specific enough that a reader can go and look it up. */
export interface LegalSource {
  /** The instrument, named as it is cited in its own jurisdiction. */
  readonly instrument: string;
  /** The provision within it: "regulation 22", "s. 6", "Article L.34-5". */
  readonly provision: string;
  /** What that provision says, in its own terms rather than in ours. */
  readonly says: string;
}

/**
 * A sign-off by someone qualified to give one.
 *
 * All three fields are required and none has a default. A review recorded as "yes, checked" with
 * no name against it is indistinguishable from a review that never happened, and being able to
 * tell those apart is the entire point of the field.
 */
export interface RegimeReview {
  /** The person or firm. Named, because an anonymous sign-off is not one. */
  readonly reviewedBy: string;
  /** ISO date of the advice. Law changes; a review has an age. */
  readonly reviewedAt: string;
  /** A file, matter or engagement reference somebody could produce on request. */
  readonly reference: string;
}

export interface CountryRule {
  readonly regime: OutreachRegime;
  /** The operative rule in one or two sentences, as this system applies it. */
  readonly note: string;
  /** At least one. The type requires it; see the header. */
  readonly sources: readonly [LegalSource, ...LegalSource[]];
  /**
   * What a reviewer has to answer for this row. Written as questions rather than as caveats,
   * because a caveat can be nodded at and a question has to be answered.
   */
  readonly openQuestions: readonly string[];
  /**
   * How confident the reading is, NOT whether it has been checked.
   *
   *   SETTLED    the headline rule is stated consistently by the regulator and is not seriously
   *              disputed. The open questions are about application, not about what the rule is.
   *   CONTESTED  competent readings differ, or the regulator's position and the statute are not
   *              obviously the same thing. Treat the row as a proposal.
   */
  readonly confidence: 'SETTLED' | 'CONTESTED';
  /** Null until a qualified person has signed this row off. Null everywhere today. */
  readonly review: RegimeReview | null;
}

/**
 * The country table.
 *
 * DELIBERATELY SHORT, AND DELIBERATELY DENY-BY-DEFAULT. A country that is not listed here
 * refuses, rather than falling back to the most permissive reading of the least information —
 * which is the exact defect §14 exists to prevent and which this gate previously contained as
 * `resolvedCountry = 'US'`.
 */
export const OUTREACH_REGIMES: Readonly<Record<string, CountryRule>> = Object.freeze({
  GB: {
    regime: 'GDPR_LI',
    note:
      'PECR restricts unsolicited marketing email to individual subscribers. Corporate ' +
      'subscribers may be contacted on a legitimate interests basis, with a right to object ' +
      'that is absolute for direct marketing. Sole traders and unincorporated partnerships ' +
      'count as individual subscribers and need consent.',
    sources: [
      {
        instrument: 'Privacy and Electronic Communications (EC Directive) Regulations 2003',
        provision: 'regulation 22',
        says:
          'Unsolicited electronic mail for direct marketing may not be transmitted to an ' +
          'individual subscriber without prior consent, subject to the soft opt-in in ' +
          'regulation 22(3) for an existing customer of a similar product.',
      },
      {
        instrument: 'Privacy and Electronic Communications (EC Directive) Regulations 2003',
        provision: 'regulation 2(1)',
        says:
          'Defines an individual to include a sole trader and an unincorporated body of ' +
          'persons; the regulator reads unincorporated partnerships the same way. This is what ' +
          'makes a sole trader at a business-looking address an individual subscriber.',
      },
      {
        instrument: 'UK GDPR',
        provision: 'Article 6(1)(f)',
        says:
          'Processing is lawful where necessary for the legitimate interests of the controller, ' +
          'except where overridden by the interests or fundamental rights of the data subject. ' +
          'This is the basis a balancing assessment documents.',
      },
      {
        instrument: 'UK GDPR',
        provision: 'Article 21(2)',
        says:
          'Where personal data are processed for direct marketing the data subject has the ' +
          'right to object at any time, and on objection the data must no longer be processed ' +
          'for that purpose. The right is absolute; there is no balancing against it.',
      },
      {
        instrument: 'UK GDPR',
        provision: 'Article 14(1) to (3)',
        says:
          'Where data were not obtained from the data subject, the controller must provide the ' +
          'listed information including the source, within a reasonable period and at the ' +
          'latest within one month, or at the time of first communication if that is earlier.',
      },
    ],
    openQuestions: [
      'Confirm that a named employee at a limited company is a corporate subscriber for ' +
        'regulation 22 purposes, so that PERSONAL and ROLE address types are both reachable.',
      'Confirm the treatment of an LLP, which is a body corporate but is often read alongside ' +
        'partnerships. This system has no way to tell an LLP from a limited company, so if ' +
        'they differ we need a field and a refusal for the unknown case.',
      'Confirm that sending the Article 14 notice as a standalone email, before any marketing ' +
        'message, is acceptable and is not itself direct marketing under PECR.',
    ],
    confidence: 'SETTLED',
    review: null,
  },

  US: {
    regime: 'OPT_OUT',
    note:
      'CAN-SPAM requires no prior permission, but does require accurate headers, a valid ' +
      'physical postal address, identification as an advertisement and a working opt-out ' +
      'honoured within ten business days.',
    sources: [
      {
        instrument: 'CAN-SPAM Act of 2003',
        provision: '15 U.S.C. 7704(a)',
        says:
          'Prohibits false or misleading header information and deceptive subject lines, and ' +
          'requires a functioning return address, a clear opt-out mechanism, and the sender ' +
          'physical postal address in each commercial electronic mail message.',
      },
      {
        instrument: 'CAN-SPAM Act of 2003',
        provision: '15 U.S.C. 7704(a)(4)(A)',
        says:
          'An opt-out request must be honoured within ten business days, after which sending ' +
          'further commercial messages to that address is unlawful.',
      },
      {
        instrument: 'FTC CAN-SPAM Rule',
        provision: '16 C.F.R. Part 316',
        says:
          'Implements the Act, including the primary-purpose test for a message and the ' +
          'treatment of transactional or relationship messages.',
      },
    ],
    openQuestions: [
      'Confirm that immediate suppression satisfies the ten-business-day rule. This system ' +
        'suppresses at once, which is stricter, but the claim should be checked against how ' +
        'the unsubscribe endpoint actually behaves rather than against the intent.',
      'Confirm whether any US state law we care about adds a consent requirement on top, and ' +
        'whether we therefore need state-level rows rather than one US row.',
      'Confirm what physical postal address we are entitled to put in the footer, and that it ' +
        'is configured. CAN-SPAM compliance fails on a missing address regardless of consent.',
    ],
    confidence: 'SETTLED',
    review: null,
  },

  NL: {
    regime: 'GDPR_LI',
    note:
      'The Dutch spam rules extend to legal persons, with an exemption where the address was ' +
      'published for the purpose of receiving such communications. This system treats the ' +
      'Netherlands as legitimate-interest-available for corporate subscribers, which is the ' +
      'narrower reading and still needs checking.',
    sources: [
      {
        instrument: 'Telecommunicatiewet',
        provision: 'Article 11.7',
        says:
          'Restricts unsolicited electronic communications for commercial, idealistic or ' +
          'charitable purposes without prior consent. The restriction covers legal persons as ' +
          'well as natural persons, with exemptions including an address published by the ' +
          'subscriber for that purpose.',
      },
      {
        instrument: 'GDPR',
        provision: 'Article 6(1)(f) and Article 14',
        says:
          'The general legitimate interests basis and the indirect-collection notice apply as ' +
          'they do across the EU; the Telecommunicatiewet governs the sending channel on top.',
      },
    ],
    openQuestions: [
      'This is the least confident row in the table. Confirm whether the published-address ' +
        'exemption in Article 11.7 covers a scraped info@ address on a company website, or ' +
        'whether it needs something closer to an explicit invitation to be contacted.',
      'If the exemption does not cover a scraped address, the Netherlands should move to ' +
        'CONSENT_REQUIRED, which this system supports today with no code change.',
      'Confirm whether the legal-person extension changes the analysis for a one-person BV.',
    ],
    confidence: 'CONTESTED',
    review: null,
  },

  FR: {
    regime: 'GDPR_LI',
    note:
      'The regulator permits business email on an opt-out basis where the message relates to ' +
      'the recipient professional role, provided the person was informed at collection and can ' +
      'object. Consumer addresses require prior consent.',
    sources: [
      {
        instrument: 'Code des postes et des communications electroniques',
        provision: 'Article L.34-5',
        says:
          'Prohibits direct marketing by electronic mail using the contact details of a natural ' +
          'person who has not given prior consent, with an exception where the person is ' +
          'contacted in a professional capacity about something relevant to that capacity.',
      },
      {
        instrument: 'CNIL published position on B2B prospecting',
        provision: 'Regulator guidance',
        says:
          'A professional may be contacted without prior consent where the message concerns ' +
          'their professional role, provided they were informed when their address was ' +
          'collected and are given a means to object at collection and in every message.',
      },
    ],
    openQuestions: [
      'The exception turns on the message relating to the recipient professional role. Confirm ' +
        'what makes that true in practice, and whether anything in this system should enforce ' +
        'it rather than leaving it to whoever writes the copy.',
      'Confirm the treatment of a generic role address such as contact@, which has at times ' +
        'been treated as not personal data at all. If that reading holds, a ROLE address and a ' +
        'PERSONAL one differ and this row should be split.',
      'Confirm whether an Article 14 notice sent after collection satisfies the requirement to ' +
        'inform at the time of collection. If it does not, France is unreachable for scraped ' +
        'data and the row should move to CONSENT_REQUIRED.',
    ],
    confidence: 'CONTESTED',
    review: null,
  },

  DE: {
    regime: 'CONSENT_REQUIRED',
    note:
      'Prior express consent is required for advertising email, including business to business. ' +
      'There is a narrow existing-customer exception this system does not attempt to use.',
    sources: [
      {
        instrument: 'Gesetz gegen den unlauteren Wettbewerb (UWG)',
        provision: 'section 7(2) no. 2',
        says:
          'Advertising using electronic mail without the prior express consent of the recipient ' +
          'is an unreasonable nuisance. The provision does not distinguish business from ' +
          'consumer recipients.',
      },
      {
        instrument: 'Gesetz gegen den unlauteren Wettbewerb (UWG)',
        provision: 'section 7(3)',
        says:
          'A narrow exception where the address was obtained in connection with a sale to that ' +
          'customer, the advertising is for similar goods, the customer has not objected, and ' +
          'is told of the right to object at collection and in every message.',
      },
    ],
    openQuestions: [
      'Confirm that CONSENT_REQUIRED is right and that we should not attempt the section 7(3) ' +
        'existing-customer exception. This system has no reliable record of who is an existing ' +
        'customer, so implementing it would mean guessing, in the permissive direction.',
      'Confirm what form of consent record is sufficient. This system stores free-text evidence ' +
        'and a named recorder, which may be weaker than what a German court expects — a double ' +
        'opt-in with a logged confirmation.',
    ],
    confidence: 'SETTLED',
    review: null,
  },

  CA: {
    regime: 'CONSENT_REQUIRED',
    note:
      'CASL requires express or implied consent before a commercial electronic message. Implied ' +
      'consent includes a conspicuously published business address, which this system does not ' +
      'attempt to rely on.',
    sources: [
      {
        instrument: 'Canadian Anti-Spam Legislation, S.C. 2010, c. 23',
        provision: 'section 6(1)',
        says:
          'It is prohibited to send a commercial electronic message unless the person to whom ' +
          'it is sent has consented, expressly or by implication, and the message identifies ' +
          'the sender and contains an unsubscribe mechanism.',
      },
      {
        instrument: 'Canadian Anti-Spam Legislation, S.C. 2010, c. 23',
        provision: 'section 10(9)(b)',
        says:
          'Consent is implied where the recipient has conspicuously published their electronic ' +
          'address without a statement that they do not wish to receive unsolicited commercial ' +
          'messages, and the message is relevant to their business role.',
      },
    ],
    openQuestions: [
      'Confirm that we should not rely on the section 10(9)(b) conspicuous-publication implied ' +
        'consent. It is the provision a scraper is most tempted by, and relying on it means ' +
        'proving a negative — that no statement refusing such messages was present — which this ' +
        'system would have to capture at scrape time and does not.',
      'If we do want to rely on it, the scraper must capture and store the page and the absence ' +
        'of a refusal statement as evidence. That is a feature, not a flag.',
    ],
    confidence: 'SETTLED',
    review: null,
  },
});

/** The rule for a country, or null when nobody has written one. */
export function ruleFor(code: string): CountryRule | null {
  return OUTREACH_REGIMES[code] ?? null;
}

/** Has a qualified person signed off this country row? A null review means no. */
export function isReviewed(code: string): boolean {
  return OUTREACH_REGIMES[code]?.review != null;
}

/** Every country in the table that has not been signed off, sorted. */
export function unreviewedCountries(): string[] {
  return Object.keys(OUTREACH_REGIMES)
    .filter((code) => !isReviewed(code))
    .sort();
}
