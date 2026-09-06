/**
 * P1.6 — FACT PROVENANCE, TEMPORAL VALIDITY AND SUPERSESSION (addendum §20, §21, §18).
 *
 * WHAT WAS WRONG
 * --------------
 * The only fact write in the repository did three disqualifying things at once:
 *
 *     await db.delete(conversationFacts).where(... conversationId ...);
 *     for (const fact of (memory as any).facts) {
 *       await db.insert(conversationFacts).values({
 *         key: 'synthesized_fact', value: fact, sourceType: 'AGENT_SYNTHESIS'
 *       });
 *     }
 *
 * It HARD-DELETES every prior fact before inserting, so supersession is not merely
 * unimplemented — it is inverted into destruction. It leaves every provenance column unset:
 * `sourceMessageId`, `observedAt`, `confidence`, `validFrom`, `validUntil` all null. And
 * `ConversationMemory` has no `facts` member, so the loop iterates `undefined` and throws —
 * after the delete has already run. The net effect of an inbound message was to erase the
 * conversation's facts and write nothing back.
 *
 * The schema declares almost exactly the right bitemporal contract. A schema is not an
 * implementation, and there was no fact store at all on Firestore, which is the datastore this
 * deployment actually runs on.
 *
 * THE RULE
 * --------
 * A fact is never deleted and never overwritten. A new observation of the same key either
 * CONFIRMS the existing fact (same value — record that we saw it again) or SUPERSEDES it (the
 * old fact gets `validUntil` and `supersededBy`, the new one gets `validFrom`). History is the
 * point: "the customer said their budget was £5k, then later said £15k" is a different thing
 * from "the customer's budget is £15k", and only the first can be audited.
 *
 * AND THE RULE THAT MATTERS FOR §18
 * ---------------------------------
 * A fact synthesised by a model from a customer's email is NOT evidence of anything. It is a
 * restatement of untrusted text, and it was being written back with `sourceType:
 * 'AGENT_SYNTHESIS'` and then re-read into later prompts — where a label that reads like
 * provenance made model output indistinguishable from something the customer actually said.
 * That is a persistent, second-order injection channel: text arrives once, becomes a "fact",
 * and gains authority it never had.
 *
 * So provenance here is not a label. It is a TIER, it is ordered, and a lower tier cannot
 * supersede a higher one.
 */

/** Where a fact came from, in ascending order of authority. */
export const SOURCE_TYPES = [
  /**
   * A model's summary of untrusted material. The lowest tier, deliberately: it is a
   * restatement of something a stranger wrote, and it is not evidence.
   */
  'AGENT_SYNTHESIS',
  /** Something the counterparty asserted in their own words. Untrusted, but at least theirs. */
  'CUSTOMER_ASSERTION',
  /** Derived by our own deterministic code from data we hold. */
  'SYSTEM_DERIVED',
  /** Returned by a provider's API — a calendar event, a payment record. */
  'PROVIDER_RECORD',
  /** Entered by a person on our side, who is accountable for it. */
  'OPERATOR_ENTRY',
] as const;

export type FactSourceType = (typeof SOURCE_TYPES)[number];

/** Higher wins. A fact may only be superseded by one of equal or greater authority. */
export function authorityOf(sourceType: FactSourceType): number {
  return SOURCE_TYPES.indexOf(sourceType);
}

/**
 * Sources whose content originated outside our trust boundary.
 *
 * This travels WITH the fact rather than being recomputed from the source type at read time,
 * because a fact derived from an untrusted fact is itself untrusted, and that has to survive a
 * hop. §18 is about authority, and authority is not restored by being copied.
 */
export const UNTRUSTED_SOURCES: ReadonlySet<FactSourceType> = new Set([
  'AGENT_SYNTHESIS',
  'CUSTOMER_ASSERTION',
]);

export interface FactObservation {
  /** What this fact is about: `budget`, `decision_maker`, `renewal_date`. */
  key: string;
  value: string;
  sourceType: FactSourceType;
  /**
   * The message this was observed in. REQUIRED for anything originating outside — an
   * unattributable claim about a customer is not a fact, and the schema declares this column
   * for exactly that reason.
   */
  sourceMessageId?: string | null;
  /** 0-100, or null when nothing computed one. Never defaulted to a number. */
  confidence?: number | null;
  /** When the fact was observed. Distinct from when it was written. */
  observedAt?: string;
  /** True when this fact was derived from material that itself came from outside. */
  derivedFromUntrusted?: boolean;
}

export interface StoredFact extends FactObservation {
  id: string;
  organizationId: string;
  conversationId: string;
  validFrom: string;
  validUntil: string | null;
  supersededBy: string | null;
  createdAt: string;
  lastVerifiedAt: string | null;
  /** How many times this exact value has been observed again. */
  observationCount: number;
  derivedFromUntrusted: boolean;
}

export const MAX_FACT_KEY = 128;
export const MAX_FACT_VALUE = 4_000;

export type FactRejection =
  | { code: 'MISSING_KEY'; message: string }
  | { code: 'MISSING_VALUE'; message: string }
  | { code: 'UNATTRIBUTED'; message: string }
  | { code: 'UNKNOWN_SOURCE_TYPE'; message: string }
  | { code: 'INVALID_CONFIDENCE'; message: string }
  | { code: 'TOO_LONG'; message: string }
  | { code: 'LOWER_AUTHORITY'; message: string };

export type FactPlan =
  | { ok: false; rejection: FactRejection }
  /** Nothing changes but the fact was seen again, which is itself worth recording. */
  | { ok: true; action: 'CONFIRM'; factId: string; patch: Record<string, unknown> }
  /** A new fact is written and the old one is closed. Never deleted. */
  | {
      ok: true;
      action: 'SUPERSEDE';
      supersededId: string;
      supersededPatch: Record<string, unknown>;
      insert: Omit<StoredFact, 'id'>;
    }
  | { ok: true; action: 'CREATE'; insert: Omit<StoredFact, 'id'> };

/**
 * Validate an observation on its own terms, before it is compared with anything.
 *
 * Returns the rejection rather than throwing: a malformed fact arriving from a model is a data
 * condition that happens routinely, not a programming error.
 */
export function validateObservation(observation: FactObservation): FactRejection | null {
  if (typeof observation.key !== 'string' || observation.key.trim().length === 0) {
    return { code: 'MISSING_KEY', message: 'A fact needs a key naming what it is about.' };
  }
  if (observation.key.length > MAX_FACT_KEY) {
    return { code: 'TOO_LONG', message: `Fact key exceeds ${MAX_FACT_KEY} characters.` };
  }
  if (typeof observation.value !== 'string' || observation.value.trim().length === 0) {
    return { code: 'MISSING_VALUE', message: 'A fact with no value is not a fact.' };
  }
  if (observation.value.length > MAX_FACT_VALUE) {
    return { code: 'TOO_LONG', message: `Fact value exceeds ${MAX_FACT_VALUE} characters.` };
  }
  if (!SOURCE_TYPES.includes(observation.sourceType)) {
    return {
      code: 'UNKNOWN_SOURCE_TYPE',
      message:
        `Unknown source type ${JSON.stringify(observation.sourceType)}. A fact whose ` +
        'provenance is not one of the declared tiers cannot be ranked against another.',
    };
  }

  // Anything originating outside must name the message it came from. Without that there is no
  // way to answer "who told us this and when", which is the entire purpose of the column.
  if (
    UNTRUSTED_SOURCES.has(observation.sourceType) &&
    (typeof observation.sourceMessageId !== 'string' || observation.sourceMessageId.length === 0)
  ) {
    return {
      code: 'UNATTRIBUTED',
      message:
        `A ${observation.sourceType} fact must name the message it was observed in. An ` +
        'unattributable claim about a customer is not a fact.',
    };
  }

  if (observation.confidence !== undefined && observation.confidence !== null) {
    const c = observation.confidence;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 100) {
      return {
        code: 'INVALID_CONFIDENCE',
        message: 'Confidence must be a number from 0 to 100, or null when nothing computed one.',
      };
    }
  }

  return null;
}

/**
 * Decide what writing this observation should do, given the fact currently in force.
 *
 * Pure. `current` is the active fact for the same key, or null when there is none.
 */
export function planFactWrite(
  current: StoredFact | null,
  observation: FactObservation,
  context: { organizationId: string; conversationId: string; now?: string; nextId?: string }
): FactPlan {
  const rejection = validateObservation(observation);
  if (rejection !== null) return { ok: false, rejection };

  const now = context.now ?? new Date().toISOString();
  const observedAt = observation.observedAt ?? now;

  // An untrusted origin propagates. A fact derived from a fact derived from a customer's email
  // is still, at bottom, that email — authority is not restored by a hop.
  const derivedFromUntrusted =
    observation.derivedFromUntrusted === true || UNTRUSTED_SOURCES.has(observation.sourceType);

  const insert: Omit<StoredFact, 'id'> = {
    organizationId: context.organizationId,
    conversationId: context.conversationId,
    key: observation.key.trim(),
    value: observation.value,
    sourceType: observation.sourceType,
    sourceMessageId: observation.sourceMessageId ?? null,
    confidence: observation.confidence ?? null,
    observedAt,
    validFrom: observedAt,
    validUntil: null,
    supersededBy: null,
    createdAt: now,
    lastVerifiedAt: now,
    observationCount: 1,
    derivedFromUntrusted,
  };

  if (current === null) {
    return { ok: true, action: 'CREATE', insert };
  }

  // Seeing the same value again is CONFIRMATION, not a new fact. Writing a second row would
  // make the history say the customer changed their mind when they simply repeated themselves.
  if (current.value === observation.value) {
    return {
      ok: true,
      action: 'CONFIRM',
      factId: current.id,
      patch: {
        lastVerifiedAt: now,
        observationCount: (current.observationCount ?? 1) + 1,
        // A repeat from a MORE authoritative source upgrades the fact's standing: the same
        // claim, now attested by someone accountable for it.
        ...(authorityOf(observation.sourceType) > authorityOf(current.sourceType)
          ? {
              sourceType: observation.sourceType,
              sourceMessageId: observation.sourceMessageId ?? current.sourceMessageId ?? null,
              derivedFromUntrusted: derivedFromUntrusted && current.derivedFromUntrusted,
            }
          : {}),
      },
    };
  }

  // The value differs, so one of them is out of date. A model's summary must not overwrite
  // what an operator entered or what a provider returned: that is how a prompt-injected
  // "correction" would rewrite the record it was injected into (§18).
  if (authorityOf(observation.sourceType) < authorityOf(current.sourceType)) {
    return {
      ok: false,
      rejection: {
        code: 'LOWER_AUTHORITY',
        message:
          `A ${observation.sourceType} observation cannot supersede a ${current.sourceType} ` +
          `fact for "${current.key}". The new value is recorded as a conflict for review, ` +
          'not written over the existing one.',
      },
    };
  }

  return {
    ok: true,
    action: 'SUPERSEDE',
    supersededId: current.id,
    supersededPatch: {
      validUntil: observedAt,
      supersededBy: context.nextId ?? null,
      updatedAt: now,
    },
    insert,
  };
}

/**
 * Whether a fact may be presented to a model as established.
 *
 * The distinction this draws is the §18 one. A fact that came from a customer's email — or
 * from a model reading a customer's email — is something a stranger asserted. Rendering it in
 * a prompt as though it were a record we hold is what turns a single injected sentence into a
 * durable instruction, so callers use this to fence such facts rather than to drop them.
 */
export function isAttestedFact(fact: Pick<StoredFact, 'derivedFromUntrusted'>): boolean {
  return fact.derivedFromUntrusted !== true;
}

/** Facts still in force, newest first. A fact with a `validUntil` is history, not current. */
export function activeFacts(facts: readonly StoredFact[]): StoredFact[] {
  return facts
    .filter((f) => f.validUntil === null || f.validUntil === undefined)
    .sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
}
