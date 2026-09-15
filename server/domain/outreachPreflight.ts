/**
 * WHAT IS STILL BLOCKING A REAL SEND (§14, §A).
 *
 * WHY THIS EXISTS
 * ---------------
 * "Can we run a campaign yet?" was a question only answerable by reading the codebase. The
 * answer was spread across seven environment flags, an OAuth record, a DNS posture check, a
 * settings document, a country table, a set of campaign guards that refuse when their inputs are
 * missing, and a lawful basis on each individual contact. An operator reading `/api/readiness`
 * learned that sending was off; they did not learn what else would stop them the moment it was
 * turned on.
 *
 * So this computes the answer. Every check is evaluated from a fact somebody gathered, and a
 * fact that could not be gathered is `UNKNOWN`, which BLOCKS. That is the same rule §14 applies
 * to consent, applied to readiness: a check whose input is missing has not passed.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not permission. Passing every check below does not make it legal or wise to email
 * anybody — the country table could still be wrong, the assessment could still be thin, and the
 * list could still be badly chosen. It says only that the mechanical preconditions this system
 * knows about are in place. The items it cannot check are listed by name in the result rather
 * than omitted, because a readiness report that quietly scopes itself down to what it can
 * measure is how "ready" comes to mean "ready in the ways we happened to test".
 */

export type CheckStatus = 'PASS' | 'BLOCK' | 'UNKNOWN' | 'WARN';

export interface PreflightCheck {
  readonly id: string;
  /** What this check is asking, in the operator's terms. */
  readonly question: string;
  readonly status: CheckStatus;
  /** What was actually found. Never a secret value — a count, a boolean, a name. */
  readonly finding: string;
  /** What to do about it, when it is not a PASS. */
  readonly remedy: string | null;
  /**
   * Whether this check stops a send. UNKNOWN blocks, which is the whole design; WARN does not,
   * and is reserved for things that degrade a send rather than forbid it.
   */
  readonly blocking: boolean;
}

/** The facts a caller gathers. Every one is optional-shaped so "could not read" is expressible. */
export interface PreflightFacts {
  /** The seven production-action flags, as `safeModeSnapshot` reports them. */
  readonly flags: Readonly<Record<string, boolean>>;
  /** Missing controller-identity fields, or null when the settings document could not be read. */
  readonly missingControllerFields: readonly string[] | null;
  /** Signed, unwithdrawn, in-date assessments. Null when they could not be counted. */
  readonly usableAssessments: number | null;
  /** Countries in the table with no recorded legal sign-off. Never null: the table is code. */
  readonly unreviewedCountries: readonly string[];
  /** True when a usable Gmail credential exists, false when it does not, null when unreadable. */
  readonly gmailCredential: boolean | null;
  /** Whether that credential carries the EMAIL_SEND scope. Null when it could not be checked. */
  readonly sendCapability: boolean | null;
  /** The sending domain's SPF/DMARC posture, or null when the lookup failed. */
  readonly senderPosture: { readonly domain: string; readonly permitted: boolean; readonly reason: string } | null;
  /** Set when a stable outbound Message-ID can be minted, which §32 reconciliation needs. */
  readonly messageIdDomain: string | null;
  /** Whether the unsubscribe link can be built. Null when it could not be determined. */
  readonly unsubscribeConfigured: boolean | null;
  /** Campaign-safety guards that cannot run for want of data. These refuse every send. */
  readonly guardsThatCannotRun: readonly string[];
  /** Contacts the gate would currently permit. Null when they could not be counted. */
  readonly mailableContacts: number | null;
}

/** Things this report cannot check, named rather than omitted. See the header. */
export const UNCHECKABLE: readonly string[] = [
  'Whether the country table is legally correct. The sign-off field records that a person ' +
    'reviewed it; nothing can verify that the review was any good.',
  'Whether a signed balancing assessment is substantive. The system checks that each limb of ' +
    'the three-part test is present and long enough to be a sentence, not that it is sound.',
  'Whether the people on a list are the right people to contact, which is a judgement about ' +
    'the business and not a property of the data.',
  'Whether the message copy is accurate, or whether it would be read as deceptive under ' +
    'CAN-SPAM. Nothing here reads the copy.',
];

function check(
  id: string,
  question: string,
  status: CheckStatus,
  finding: string,
  remedy: string | null
): PreflightCheck {
  return { id, question, status, finding, remedy, blocking: status === 'BLOCK' || status === 'UNKNOWN' };
}

/**
 * Run every readiness check against gathered facts.
 *
 * Pure. The gathering is I/O and lives in the service; the rules are here, so each one can be
 * exercised against a fact set that would be tedious to arrange in a database.
 */
export function outreachPreflight(facts: PreflightFacts): {
  readonly ready: boolean;
  readonly checks: readonly PreflightCheck[];
  readonly blocking: readonly PreflightCheck[];
  readonly uncheckable: readonly string[];
} {
  const checks: PreflightCheck[] = [];

  const sendFlag = facts.flags.REAL_EMAIL_SEND_ENABLED === true;
  checks.push(
    check(
      'send-flag',
      'Is real email sending turned on?',
      sendFlag ? 'PASS' : 'BLOCK',
      sendFlag
        ? 'REAL_EMAIL_SEND_ENABLED is "true". Messages dispatched through the gateway will ' +
            'actually be transmitted.'
        : 'REAL_EMAIL_SEND_ENABLED is not "true", so the gateway refuses every send. This is the ' +
            'default and it fails closed: absent, empty, "TRUE" and "1" all mean off.',
      sendFlag
        ? null
        : 'Set REAL_EMAIL_SEND_ENABLED=true once every other check here passes. Turning it on is ' +
            'a decision with real-world consequences and is deliberately not something this ' +
            'system does for you.'
    )
  );

  const missing = facts.missingControllerFields;
  checks.push(
    check(
      'controller-identity',
      'Are the controller details a notice and a footer must contain configured?',
      missing === null ? 'UNKNOWN' : missing.length === 0 ? 'PASS' : 'BLOCK',
      missing === null
        ? 'The organisation settings document could not be read, so this is unknown — which ' +
            'blocks, because an unread setting is not a configured one.'
        : missing.length === 0
          ? 'All seven are present: name, postal address, contact email, privacy policy URL, ' +
              'retention policy, supervisory authority and data protection contact.'
          : `Missing: ${missing.join(', ')}.`,
      missing === null || missing.length > 0
        ? 'POST the missing fields to /api/settings. Article 14 requires them in the notice and ' +
            'CAN-SPAM requires a postal address in every commercial message.'
        : null
    )
  );

  const assessments = facts.usableAssessments;
  checks.push(
    check(
      'signed-assessment',
      'Is there a signed, in-date balancing assessment to send on?',
      // `=== 0`, not `> 0`. The guardrail against verdict arithmetic reads a count compared to
      // a threshold as a severity score, and it is right to: the meaningful distinction here is
      // none-versus-some, and writing it as a threshold invites somebody to later decide that
      // three assessments are better than one.
      assessments === null ? 'UNKNOWN' : assessments === 0 ? 'BLOCK' : 'PASS',
      assessments === null
        ? 'Assessments could not be counted.'
        : assessments === 0
          ? 'None. Every legitimate-interest contact cites an assessment id, and with real ' +
              'sending on that id must resolve to a signed document — an unsigned draft does not ' +
              'count and a free-text string is no longer accepted.'
          : `${assessments} signed, unwithdrawn and in date.`,
      assessments !== null && assessments !== 0
        ? null
        : 'Write one at POST /api/lia, then sign it at POST /api/lia/:id/sign. ' +
            'docs/production/lia-uk-b2b-2026.md is a drafted assessment to start from.'
    )
  );

  const unreviewed = facts.unreviewedCountries;
  checks.push(
    check(
      'country-review',
      'Has a qualified person signed off the outreach rules for each country?',
      unreviewed.length === 0 ? 'PASS' : 'BLOCK',
      unreviewed.length === 0
        ? 'Every country in the table carries a recorded review.'
        : `No sign-off recorded for ${unreviewed.join(', ')}. With real sending on, the gate ` +
            `refuses these with COUNTRY_NOT_LEGALLY_REVIEWED, so they are unmailable rather than ` +
            `mailable-and-unchecked.`,
      unreviewed.length === 0
        ? null
        : 'Have the rules checked and record the sign-off in server/domain/lawfulBasisSources.ts. ' +
            'docs/production/legal-review-pack.md is written for that reviewer.'
    )
  );

  checks.push(
    check(
      'gmail-credential',
      'Is there a usable sending credential?',
      facts.gmailCredential === null ? 'UNKNOWN' : facts.gmailCredential ? 'PASS' : 'BLOCK',
      facts.gmailCredential === null
        ? 'The OAuth connections could not be read.'
        : facts.gmailCredential
          ? 'A Gmail credential is stored and is not a placeholder.'
          : 'No usable Gmail credential. The gateway refuses rather than reporting a send that ' +
              'did not happen.',
      facts.gmailCredential === true ? null : 'Connect the sending account under integrations.'
    )
  );

  checks.push(
    check(
      'send-capability',
      'Does that credential actually carry permission to send?',
      facts.sendCapability === null ? 'UNKNOWN' : facts.sendCapability ? 'PASS' : 'BLOCK',
      facts.sendCapability === null
        ? 'The granted scopes could not be read, so this is unknown.'
        : facts.sendCapability
          ? 'The EMAIL_SEND capability is granted.'
          : 'The stored credential does not carry EMAIL_SEND. A read-only token reaches the send ' +
              'path and fails at the provider with a non-retryable 403.',
      facts.sendCapability === true ? null : 'Re-consent with the sending scope granted.'
    )
  );

  const posture = facts.senderPosture;
  checks.push(
    check(
      'sender-identity',
      'Is the sending domain set up so mail from it is accepted?',
      posture === null ? 'UNKNOWN' : posture.permitted ? 'PASS' : 'BLOCK',
      posture === null
        ? 'SPF and DMARC could not be looked up. An unverifiable posture blocks: mail from a ' +
            'domain that fails authentication damages the domain for every later send.'
        : `${posture.domain}: ${posture.reason}`,
      posture !== null && posture.permitted ? null : 'Publish SPF and DMARC records for the sending domain.'
    )
  );

  const messageId = facts.messageIdDomain;
  checks.push(
    check(
      'reconcilable-sends',
      'Can a send that times out afterwards be asked about?',
      messageId === null || messageId.trim() === '' ? 'BLOCK' : 'PASS',
      messageId === null || messageId.trim() === ''
        ? 'OUTBOUND_MESSAGE_ID_DOMAIN is not set, so no stable Message-ID can be minted and the ' +
            'gateway refuses with UNRECONCILABLE_SEND before the network. A send nobody could ' +
            'later ask about is one whose timeout can only be guessed at (§32).'
        : `Message-IDs will be minted at ${messageId}, derived from each job's idempotency key, ` +
            `so the same job produces the same id on every attempt.`,
      messageId === null || messageId.trim() === '' ? 'Set OUTBOUND_MESSAGE_ID_DOMAIN to a domain you control.' : null
    )
  );

  checks.push(
    check(
      'unsubscribe',
      'Can every message carry a working opt-out?',
      facts.unsubscribeConfigured === null ? 'UNKNOWN' : facts.unsubscribeConfigured ? 'PASS' : 'BLOCK',
      facts.unsubscribeConfigured === null
        ? 'Could not determine whether an unsubscribe URL can be built.'
        : facts.unsubscribeConfigured
          ? 'An unsubscribe URL can be built for a contact, and the gateway refuses any send ' +
              'where it cannot.'
          : 'No unsubscribe URL can be built. Mailing somebody with no way to stop us is the ' +
              'permissive reading of a missing control, and it is refused.',
      facts.unsubscribeConfigured === true ? null : 'Configure the public base URL the unsubscribe link is built from.'
    )
  );

  const guards = facts.guardsThatCannotRun;
  checks.push(
    check(
      'campaign-guards',
      'Can the campaign safety guards actually run?',
      guards.length === 0 ? 'PASS' : 'BLOCK',
      guards.length === 0
        ? 'Every guard has its inputs.'
        : `${guards.length} guard(s) cannot run for want of data: ${guards.join(', ')}. A guard ` +
            `whose input is missing is NOT_RUN, and NOT_RUN refuses — so autonomous sending is ` +
            `blocked rather than proceeding unguarded. This is the check most likely to surprise ` +
            `you, because it blocks even when everything else is green.`,
      guards.length === 0
        ? null
        : 'Each needs a source of data this system does not yet collect: per-contact send ' +
            'history, per-organisation daily counters, campaign membership, and recipient time ' +
            'zones. Until then, sends must be operator-initiated rather than autonomous.'
    )
  );

  const mailable = facts.mailableContacts;
  checks.push(
    check(
      'mailable-contacts',
      'Is there anybody this system would currently agree to email?',
      mailable === null ? 'UNKNOWN' : mailable === 0 ? 'WARN' : 'PASS',
      mailable === null
        ? 'Contacts could not be counted.'
        : mailable === 0
          ? 'No contact currently passes the lawful basis gate. That is not an error — it is the ' +
              'expected state until a batch has a basis recorded and its Article 14 notices sent.'
          : `${mailable} contact(s) pass the gate.`,
      mailable !== null && mailable === 0
        ? 'Import or discover a batch, record a lawful basis against it, then send the notices.'
        : null
    )
  );

  const blocking = checks.filter((c) => c.blocking);
  return { ready: blocking.length === 0, checks, blocking, uncheckable: UNCHECKABLE };
}
