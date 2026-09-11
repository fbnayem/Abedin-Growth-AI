import type { Meeting } from './models';

/**
 * WHICH MISSED-MEETING RECOVERY EMAIL COMES NEXT.
 *
 * `MissedMeetingRecoveryModal` pre-selected a variation with
 *
 *     (meeting.missedRecoveryStage as 1 | 2 | 3 | 4) || 1
 *
 * but `missedRecoveryStage` is a STRING — `'NONE'`, `'DISPATCHED_15MIN'` and so on. The cast told
 * the compiler a string was a number, and `|| 1` never fired because a non-empty string is truthy.
 * So the selected variation was `'DISPATCHED_15MIN'`, which matched no variation id, and the modal
 * fell back to the first option whatever had already been sent. The compiler could not report it
 * while React's types were absent, because the component's props were `any`.
 *
 * A stage names what has already been DISPATCHED, so the variation to offer is the one after it.
 */

/** 1: 15-minute reconnect. 2: Day-1 video. 3: Day-3 value audit. 4: Day-5 phone test. */
export type RecoveryVariation = 1 | 2 | 3 | 4;

export type RecoveryStage = NonNullable<Meeting['missedRecoveryStage']>;

const NEXT_AFTER: Readonly<Record<RecoveryStage, RecoveryVariation>> = {
  NONE: 1,
  DISPATCHED_15MIN: 2,
  DISPATCHED_DAY1_VIDEO: 3,
  DISPATCHED_DAY3_VALUE: 4,
  // The last variation has no successor. Offering it again is a choice an operator makes with the
  // history in front of them; offering the first again would restart a sequence already finished.
  DISPATCHED_DAY5_PHONE_TEST: 4,
};

function isRecoveryStage(value: unknown): value is RecoveryStage {
  // `hasOwnProperty`, not `in`: `'toString' in NEXT_AFTER` is true, and would have read a
  // function off the prototype as a variation.
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(NEXT_AFTER, value);
}

/** The variation to offer, given what has been sent. Anything unrecognised starts at the first. */
export function nextRecoveryVariation(stage: unknown): RecoveryVariation {
  return isRecoveryStage(stage) ? NEXT_AFTER[stage] : 1;
}
