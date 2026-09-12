/**
 * S26 — the campaign sequence, as decisions that need no datastore.
 *
 * WHAT WAS THERE
 * --------------
 * Fourteen guards (`campaignSafety.ts`), a `campaign_recipients` table with the right unique
 * constraint, a recipient state machine with eleven states, and a campaign document carrying
 * `steps[]` — and nothing that enrolled a contact, chose a step, rendered it, or advanced anyone.
 * The guards protected sequences that could not run. This module is the part of the engine that
 * can be proved by calling it: which step is next, when it is due, what the template becomes for
 * this contact, and where a recipient goes when the outbox reports on a step's job.
 *
 * WHAT IT REFUSES
 * ---------------
 * A step whose delay is not a number is not scheduled: a guessed delay is a send at a time
 * nobody chose (§14). A template whose merge tag has no value for this contact is not rendered:
 * "Hi {{firstName}}," is a defect delivered to a stranger, not a message. Both are refusals the
 * service records on the recipient, with the tag or the step named, rather than substitutions.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * Only EMAIL steps are performed. A LINKEDIN_TASK or VOICE_CALL_TRIGGER step is a task for a
 * person; the engine records it as not performed and moves to the next step, so a sequence
 * that mixes channels still finishes its email steps and says which steps it skipped.
 */

export type StepType = 'EMAIL' | 'LINKEDIN_TASK' | 'VOICE_CALL_TRIGGER';

export interface SequenceStep {
  /** 1-based, in the order the campaign lists its steps — that order is the schedule. */
  readonly stepNumber: number;
  readonly stepType: StepType;
  /** Days after the previous step (or after enrolment, for the first). `null`: not stated. */
  readonly delayDays: number | null;
  readonly subjectTemplate: string;
  readonly bodyTemplate: string;
  readonly title: string | null;
}

export type StepsReading = { ok: true; steps: SequenceStep[] } | { ok: false; reason: string };

const STEP_TYPES: readonly string[] = ['EMAIL', 'LINKEDIN_TASK', 'VOICE_CALL_TRIGGER'];

/**
 * The steps a campaign document declares, normalised. Two spellings of the delay exist in this
 * repository — `delayDays` (what the strategy route writes) and `dayOffset` (the shared type) —
 * and both are read; a delay that is neither is `null`, which schedules nothing.
 */
export function readSteps(campaign: unknown): StepsReading {
  const raw = (campaign as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, reason: 'the campaign declares no steps' };
  const steps: SequenceStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] as Record<string, unknown> | null;
    if (s === null || typeof s !== 'object') return { ok: false, reason: `step ${i + 1} is not an object` };
    const type = s.stepType === undefined ? 'EMAIL' : s.stepType;
    if (typeof type !== 'string' || !STEP_TYPES.includes(type)) {
      return { ok: false, reason: `step ${i + 1} has an unknown type ${JSON.stringify(type)}` };
    }
    const declared = typeof s.delayDays === 'number' ? s.delayDays : typeof s.dayOffset === 'number' ? s.dayOffset : null;
    steps.push({
      stepNumber: i + 1,
      stepType: type as StepType,
      delayDays: declared !== null && Number.isFinite(declared) && declared >= 0 ? declared : null,
      subjectTemplate: typeof s.subjectTemplate === 'string' ? s.subjectTemplate : '',
      bodyTemplate: typeof s.bodyTemplate === 'string' ? s.bodyTemplate : '',
      title: typeof s.title === 'string' ? s.title : null,
    });
  }
  return { ok: true, steps };
}

/** The step to perform next after `stepsDone` steps, or null when the sequence is finished. */
export function nextStepFor(steps: readonly SequenceStep[], stepsDone: number): SequenceStep | null {
  return Number.isInteger(stepsDone) && stepsDone >= 0 && stepsDone < steps.length ? steps[stepsDone] : null;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** When a step falls due, counted from the moment the previous one was sent (or enrolment). */
export function dueAtFor(step: SequenceStep, from: Date): Date | null {
  return step.delayDays === null ? null : new Date(from.getTime() + step.delayDays * DAY_MS);
}

export const MERGE_TAGS = ['firstName', 'lastName', 'name', 'companyName', 'title', 'email'] as const;

export type Rendering = { ok: true; text: string } | { ok: false; unresolved: string[] };

function valueFor(tag: string, contact: Record<string, unknown>): string | null {
  const direct = contact[tag];
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim();
  if (tag === 'name') {
    const parts = [contact.firstName, contact.lastName].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    if (parts.length > 0) return parts.map((p) => p.trim()).join(' ');
  }
  if (tag === 'firstName' && typeof contact.name === 'string' && contact.name.trim() !== '') {
    return contact.name.trim().split(/\s+/)[0];
  }
  return null;
}

/**
 * `{{tag}}` replaced from the contact. A tag this module does not know, or one the contact has
 * no value for, leaves the template unrendered and names the tag: the caller refuses the step.
 */
export function renderTemplate(template: string, contact: Record<string, unknown>): Rendering {
  const unresolved: string[] = [];
  const text = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, tag: string) => {
    if (!(MERGE_TAGS as readonly string[]).includes(tag)) {
      unresolved.push(tag);
      return whole;
    }
    const value = valueFor(tag, contact);
    if (value === null) {
      unresolved.push(tag);
      return whole;
    }
    return value;
  });
  return unresolved.length === 0 ? { ok: true, text } : { ok: false, unresolved: [...new Set(unresolved)] };
}

/** Plain text to the HTML body the outbox requires: escaped, paragraphs and line breaks kept. */
export function htmlFromText(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const paragraphs = escaped.split(/\r?\n\r?\n/).map((p) => p.replace(/\r?\n/g, '<br>'));
  return `<p>${paragraphs.join('</p><p>')}</p>`;
}

/** The recipient's local hour, 0–23, or undefined when the zone is absent or not a zone. */
export function localHourIn(timeZone: unknown, at: Date): number | undefined {
  if (typeof timeZone !== 'string' || timeZone === '') return undefined;
  try {
    const rendered = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at);
    const hour = Number.parseInt(rendered, 10);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : undefined;
  } catch {
    return undefined;
  }
}

export function utcDayStart(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * Where a SENDING recipient goes once the outbox has spoken. PROCESSED advances; DEAD_LETTER
 * and CANCELLED are the end of that step's job and the recipient is FAILED, for an operator;
 * anything else (PENDING, CLAIMED, HUMAN_REVIEW, a FAILED job still retrying) is in flight.
 */
export function recipientAfterJob(jobStatus: unknown, hasMoreSteps: boolean): 'AWAITING_NEXT_STEP' | 'COMPLETED' | 'FAILED' | null {
  if (jobStatus === 'PROCESSED') return hasMoreSteps ? 'AWAITING_NEXT_STEP' : 'COMPLETED';
  if (jobStatus === 'DEAD_LETTER' || jobStatus === 'CANCELLED') return 'FAILED';
  return null;
}

/** Guards whose refusal is about the person, not the moment: the recipient leaves the sequence. */
export const TERMINAL_GUARDS = ['SUPPRESSION', 'HARD_BOUNCE', 'SPAM_COMPLAINT', 'WRONG_PERSON'] as const;

export function stopStateFor(refusedGuards: readonly string[]): 'SUPPRESSED' | null {
  return refusedGuards.some((g) => (TERMINAL_GUARDS as readonly string[]).includes(g)) ? 'SUPPRESSED' : null;
}
