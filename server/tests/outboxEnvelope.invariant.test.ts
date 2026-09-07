import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import {
  readEnvelope,
  readEnvelopeFor,
  mayDispatch,
  deadLetterReason,
  OUTBOX_PAYLOAD_VERSION,
  SUPPORTED_PAYLOAD_VERSIONS,
  type EnvelopeDecision,
} from '../domain/outboxEnvelope';

/**
 * S48 — WHAT A WORKER IS ALLOWED TO ASSUME ABOUT A JOB ANOTHER BUILD ENQUEUED.
 *
 * `OutboxPayload` declared seven fields and no version. The worker destructured `job.payload.to`
 * and six more straight into an `ActionRequest` whose `payload` is typed `any`, with no
 * validation anywhere on the path. A worker could not reject an unsupported payload version
 * because it could not detect one.
 *
 * That only matters during a rolling deploy — the only time two builds run at once — and it
 * fails in both directions. Forward: a new build adds a required field, old web instances are
 * still enqueuing, and the worker cannot tell "old job" from "new job with the field
 * deliberately absent", so it dispatches with the new constraint defaulted open. Backward: a
 * rollback puts the old worker in front of new-format jobs, it ignores the fields it does not
 * know, applies none of the new constraint, and reports every send as SUCCESS.
 *
 * The backward case is the worse one, and it is the one nobody writes a test for, so both
 * directions are exercised here for real rather than one being assumed from the other.
 */

const validPayload = {
  to: 'someone@example.com',
  subject: 'Following up',
  htmlBody: '<p>hello</p>',
};

const kindsOf = (d: EnvelopeDecision) => d.kind;

// ===========================================================================
describe('1. a rolling deploy, in both directions', () => {
  /**
   * FORWARD. A v1 job is in the queue; the worker has been upgraded and now executes only v2.
   * The old job must stop, not be interpreted under the new shape.
   */
  it('a v2-only worker refuses a v1 job', () => {
    const d = readEnvelopeFor({ schemaVersion: 1, payload: validPayload }, [2]);
    expect(kindsOf(d)).toBe('UNSUPPORTED_VERSION');
    expect(mayDispatch(d)).toBe(false);
  });

  /**
   * BACKWARD. A v2 job is in the queue and the deploy has been rolled back to a v1 worker. This
   * is the direction that used to succeed silently: the old worker reads the fields it knows,
   * drops the ones it does not, and every send reports SUCCESS.
   */
  it('a v1-only worker refuses a v2 job, and says it is a rollback', () => {
    const d = readEnvelopeFor({ schemaVersion: 2, payload: validPayload }, [1]);
    expect(kindsOf(d)).toBe('UNSUPPORTED_VERSION');
    expect(mayDispatch(d)).toBe(false);
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.reason).toMatch(/NEWER build|rollback/);
  });

  /** The window a deploy actually needs: a build that emits v2 while still executing v1. */
  it('a worker that supports both versions executes both', () => {
    for (const version of [1, 2]) {
      const d = readEnvelopeFor({ schemaVersion: version, payload: validPayload }, [1, 2]);
      expect(kindsOf(d)).toBe('EXECUTE');
    }
  });

  it('the version it found is reported, so the dead letter says which build wrote the job', () => {
    const d = readEnvelopeFor({ schemaVersion: 7, payload: validPayload }, [1]);
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.found).toBe(7);
  });
});

// ===========================================================================
describe('2. an unversioned job is not assumed to be version 1', () => {
  /**
   * The whole point, and the tempting shortcut. Reading an absent version as "the oldest one"
   * is the same inference as the forward failure above — absence read as a specific known
   * value — and §14 forbids it: unknown must never resolve to permission.
   */
  it('refuses a job with no schemaVersion', () => {
    const d = readEnvelope({ payload: validPayload });
    expect(kindsOf(d)).toBe('UNSUPPORTED_VERSION');
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.found).toBeNull();
  });

  it('refuses it even when the payload is a perfectly valid v1 payload', () => {
    // The payload parsing cleanly is exactly what makes the shortcut tempting.
    expect(mayDispatch(readEnvelope({ payload: validPayload }))).toBe(false);
  });

  it('an explicit null version is treated the same as an absent one', () => {
    expect(kindsOf(readEnvelope({ schemaVersion: null, payload: validPayload }))).toBe(
      'UNSUPPORTED_VERSION'
    );
  });

  it('says how to resolve it deliberately, rather than leaving an operator guessing', () => {
    const d = readEnvelope({ payload: validPayload });
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.reason).toMatch(/backfill-outbox-version/i);
  });

  /** A version that is not an integer is not a version, however number-like it looks. */
  it('refuses a version that is not an integer', () => {
    for (const bad of ['1', 1.5, true, {}, [], NaN, Infinity]) {
      const d = readEnvelope({ schemaVersion: bad, payload: validPayload });
      expect(kindsOf(d)).toBe('UNSUPPORTED_VERSION');
    }
  });

  /**
   * And refuses it AS a malformed version, not as version 1.5 being unsupported.
   *
   * Both refuse, so the outcome is the same and the reported cause is not. `found: 1.5` invites
   * the obvious next move — add 1.5 to the supported list — which cannot be right for a value
   * that is not a version at all. A mutation dropping the integer check survived every other
   * assertion here for exactly that reason: it changed only the explanation.
   */
  it('a non-integer is reported as not-a-version, not as an unsupported version number', () => {
    const d = readEnvelope({ schemaVersion: 1.5, payload: validPayload });
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.found).toBeNull();
    expect(d.kind === 'UNSUPPORTED_VERSION' && d.reason).toMatch(/not an integer/);
  });
});

// ===========================================================================
describe('3. the payload is parsed, not destructured', () => {
  it('accepts a valid v1 payload', () => {
    const d = readEnvelope({ schemaVersion: 1, payload: validPayload });
    expect(kindsOf(d)).toBe('EXECUTE');
    expect(d.kind === 'EXECUTE' && d.payload.to).toBe('someone@example.com');
  });

  /**
   * Strictness is the discipline. An unrecognised field on something claiming to be v1 means
   * the producer and this build disagree about what v1 is, and accepting it while ignoring the
   * extra field IS the backward failure — just inside one version number instead of across two.
   */
  it('refuses a v1 payload carrying a field v1 does not have', () => {
    const d = readEnvelope({
      schemaVersion: 1,
      payload: { ...validPayload, consentBasis: 'LEGITIMATE_INTEREST' },
    });
    expect(kindsOf(d)).toBe('MALFORMED');
    expect(d.kind === 'MALFORMED' && d.reason).toMatch(/consentBasis/);
  });

  it('refuses a payload missing a required field', () => {
    for (const missing of ['to', 'subject', 'htmlBody']) {
      const payload: Record<string, unknown> = { ...validPayload };
      delete payload[missing];
      const d = readEnvelope({ schemaVersion: 1, payload });
      expect(kindsOf(d)).toBe('MALFORMED');
      expect(d.kind === 'MALFORMED' && d.reason).toContain(missing);
    }
  });

  it('refuses an empty recipient, which would otherwise reach the provider as a blank To', () => {
    expect(kindsOf(readEnvelope({ schemaVersion: 1, payload: { ...validPayload, to: '' } }))).toBe(
      'MALFORMED'
    );
  });

  it('refuses a payload that is not an object at all', () => {
    for (const payload of [undefined, null, 'a string', 42, []]) {
      expect(kindsOf(readEnvelope({ schemaVersion: 1, payload }))).toBe('MALFORMED');
    }
  });

  /**
   * A wrong version and an unparseable payload are different problems — one is a fact about the
   * deploy, the other is a bug — and the dead-letter reason is the only place anyone will read
   * the difference.
   */
  it('distinguishes an unsupported version from a malformed payload', () => {
    expect(kindsOf(readEnvelopeFor({ schemaVersion: 9, payload: 'nonsense' }, [1]))).toBe(
      'UNSUPPORTED_VERSION'
    );
    expect(kindsOf(readEnvelopeFor({ schemaVersion: 1, payload: 'nonsense' }, [1]))).toBe(
      'MALFORMED'
    );
  });
});

// ===========================================================================
describe('4. nothing but EXECUTE reaches a provider', () => {
  const everyKind: EnvelopeDecision[] = [
    { kind: 'EXECUTE', version: 1, payload: validPayload },
    { kind: 'UNSUPPORTED_VERSION', found: 2, reason: 'x' },
    { kind: 'UNSUPPORTED_VERSION', found: null, reason: 'x' },
    { kind: 'MALFORMED', reason: 'x' },
  ];

  it('mayDispatch is true for EXECUTE and false for every other kind', () => {
    expect(everyKind.filter((d) => mayDispatch(d)).map(kindsOf)).toEqual(['EXECUTE']);
  });

  /**
   * Returning a reason for a sendable job would let a caller dead-letter one by mistake — the
   * failure direction that loses a customer's reply rather than delaying it.
   */
  it('deadLetterReason refuses to invent a reason for a job that is fine', () => {
    expect(() => deadLetterReason(everyKind[0])).toThrow();
  });

  it('every refusal carries its kind into the reason, so the queue is greppable', () => {
    for (const d of everyKind.slice(1)) {
      expect(deadLetterReason(d)).toContain(d.kind);
    }
  });
});

// ===========================================================================
describe('5. the build can execute what it produces', () => {
  /**
   * A build that emits a version it cannot run dead-letters its own jobs — every one of them,
   * immediately, in production, and only once something is actually enqueued. The two constants
   * are deliberately separate so a deploy can widen support before switching production, which
   * is exactly the arrangement that makes this mistake easy.
   */
  it('the produced version is in the supported set', () => {
    expect(SUPPORTED_PAYLOAD_VERSIONS).toContain(OUTBOX_PAYLOAD_VERSION);
  });

  it('a round trip through the producer version executes', () => {
    const d = readEnvelope({ schemaVersion: OUTBOX_PAYLOAD_VERSION, payload: validPayload });
    expect(kindsOf(d)).toBe('EXECUTE');
  });
});

// ===========================================================================
/**
 * The decision is only worth anything where it is wired in. These read the source, because
 * exercising the worker end to end needs Firestore, a gateway and a provider; what they pin is
 * the ordering — that the refusal happens BEFORE `dispatchAction`, and that what is dispatched
 * is the parsed payload rather than the raw document the check just looked at.
 */
describe('6. the worker refuses before it dispatches', () => {
  const worker = readFileSync('server/workers/outbox.worker.ts', 'utf8');
  const service = readFileSync('server/services/outbox.service.ts', 'utf8');

  it('the envelope is read and refused before any gateway call', () => {
    const check = worker.indexOf('mayDispatch(envelope) === false');
    const dispatch = worker.indexOf('actionGateway.dispatchAction');
    expect(check).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(check).toBeLessThan(dispatch);
  });

  it('the refusal is terminal, not a retry that reaches the same place five attempts later', () => {
    expect(worker).toMatch(/markFailed\(orgId, job\.id, reason, true\)/);
  });

  /**
   * Reading the raw payload after validating the parsed one would make the validation
   * decorative: the check would pass and the send would still use whatever the datastore held.
   *
   * Asserted over EVERY `.payload` access rather than by forbidding the string `job.payload`,
   * because that spelling is one cast away from being something else — `(job as {…}).payload.to`
   * reads the same document and survived the narrower check. Every access must be through the
   * parsed envelope, whatever the expression in front of it looks like.
   */
  it('every payload access in the worker is through the parsed envelope', () => {
    const withoutComments = worker
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    const accessors = [...withoutComments.matchAll(/([A-Za-z_$][\w$]*|\))\s*\.payload\b/g)].map(
      (m) => m[1]
    );
    expect(accessors.length).toBeGreaterThan(0);
    expect([...new Set(accessors)]).toEqual(['envelope']);
  });

  it('the producer stamps the version and its own identity on every job', () => {
    expect(service).toMatch(/schemaVersion: OUTBOX_PAYLOAD_VERSION/);
    expect(service).toMatch(/producer: PRODUCER_ID/);
  });
});
