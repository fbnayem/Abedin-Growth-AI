import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { GoogleCalendarService } from '../services/calendar.service';
import {
  Clock,
  DEFAULT_BUSINESS_HOURS,
  DATE_TIME_LOCAL_PATTERN,
  TimeError,
  assertTimeZone,
  civilToInstant,
  dayWindow,
  describeScheduledTime,
  fixedClock,
  formatCivil,
  fromDateTimeLocalValue,
  isValidTimeZone,
  isWithinBusinessHours,
  localDateKey,
  nextBusinessSlot,
  offsetMinutesAt,
  parseInstant,
  scheduledInstant,
  scheduledTime,
  supportedTimeZones,
  systemClock,
  timeZoneRejection,
  toDateTimeLocalValue,
  toIsoOrNull,
  tryParseInstant,
  zonedFields,
} from '../../shared/domain/time';

const civil = (year: number, month: number, day: number, hour: number, minute: number) => ({
  year,
  month,
  day,
  hour,
  minute,
  second: 0,
});

/**
 * These dates are not decorative. Europe/London springs forward at 01:00 UTC on 2026-03-29 and
 * falls back at 01:00 UTC on 2026-10-25; America/New_York on 2026-03-08 and 2026-11-01;
 * Australia/Lord_Howe shifts by THIRTY minutes, which catches code that assumes an hour.
 */
describe('P1.9 — time correctness', () => {
  // -------------------------------------------------------------------------
  describe('zones are IANA identifiers, and Intl accepting a string proves nothing', () => {
    it('"BST" is REFUSED — Intl resolves it to Asia/Dhaka, five hours from London', () => {
      // The measurement that motivates the whole rule. British Summer Time and Bangladesh
      // Standard Time share an abbreviation, and Intl silently picks the wrong one.
      const viaIntl = new Intl.DateTimeFormat('en-GB', { timeZone: 'BST' }).resolvedOptions().timeZone;
      expect(viaIntl).toBe('Asia/Dhaka');
      expect(isValidTimeZone('BST')).toBe(false);
      expect(timeZoneRejection('BST')).toContain('Bangladesh');
    });

    it('the reply composer’s old comment named a zone five hours from what it produced', () => {
      const probe = new Date('2026-07-01T12:00:00Z');
      const asBst = new Intl.DateTimeFormat('en-GB', { timeZone: 'BST', hourCycle: 'h23', hour: '2-digit' }).format(probe);
      const asLondon = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', hour: '2-digit' }).format(probe);
      expect(asBst).not.toBe(asLondon);
      expect(Number(asBst) - Number(asLondon)).toBe(5);
    });

    it('other abbreviations are refused too, with a reason that explains the class', () => {
      for (const abbreviation of ['EST', 'PST', 'CET', 'IST', 'GMT']) {
        expect(isValidTimeZone(abbreviation)).toBe(false);
        expect(timeZoneRejection(abbreviation)).toContain('abbreviation');
      }
    });

    it('fixed offsets are refused: an offset cannot express a DST transition', () => {
      for (const offset of ['+01:00', '-05:00', '+0530', '-08']) {
        expect(isValidTimeZone(offset)).toBe(false);
        expect(timeZoneRejection(offset)).toContain('daylight-saving');
      }
    });

    it('a case variant is refused, so two rows naming one zone compare equal', () => {
      expect(isValidTimeZone('europe/london')).toBe(false);
      expect(timeZoneRejection('europe/london')).toContain('case-sensitive');
      expect(isValidTimeZone('Europe/London')).toBe(true);
    });

    it('real identifiers, and UTC, are accepted', () => {
      for (const zone of ['Europe/London', 'America/New_York', 'Asia/Dhaka', 'Australia/Lord_Howe', 'UTC']) {
        expect(isValidTimeZone(zone)).toBe(true);
        expect(timeZoneRejection(zone)).toBeNull();
      }
    });

    it('non-strings and empty strings are refused rather than coerced', () => {
      for (const bad of [null, undefined, 0, '', {}, [], true]) {
        expect(isValidTimeZone(bad)).toBe(false);
        expect(() => assertTimeZone(bad)).toThrow(TimeError);
      }
    });

    it('supportedTimeZones is a real, sorted list containing UTC', () => {
      const zones = supportedTimeZones();
      expect(zones.length).toBeGreaterThan(100);
      expect(zones).toContain('UTC');
      expect(zones).toContain('Europe/London');
      expect([...zones].sort()).toEqual(zones);
    });
  });

  // -------------------------------------------------------------------------
  describe('an instant must carry an offset', () => {
    it('an offset-less string is REFUSED, not read as the machine’s local time', () => {
      // Measured: on a UTC+6 machine these two are six hours apart, and the meetings route
      // accepted both into the same field.
      expect(new Date('2026-09-07T14:00Z').toISOString()).toBe('2026-09-07T14:00:00.000Z');
      expect(() => parseInstant('2026-09-07T14:00')).toThrow(TimeError);
      expect(tryParseInstant('2026-09-07T14:00')).toBeNull();
    });

    it('Z and explicit offsets are accepted and mean what they say', () => {
      expect(parseInstant('2026-09-07T14:00:00Z').toISOString()).toBe('2026-09-07T14:00:00.000Z');
      expect(parseInstant('2026-09-07T14:00:00+01:00').toISOString()).toBe('2026-09-07T13:00:00.000Z');
      expect(parseInstant('2026-09-07T14:00:00.500Z').toISOString()).toBe('2026-09-07T14:00:00.500Z');
    });

    it('a date with no time is refused: midnight in which zone?', () => {
      expect(tryParseInstant('2026-09-07')).toBeNull();
    });

    it('an impossible date inside a well-formed string is refused', () => {
      expect(tryParseInstant('2026-02-31T14:00:00Z')).toBeNull();
      expect(tryParseInstant('2026-13-01T14:00:00Z')).toBeNull();
    });

    it('a Date instance passes through, but a broken one does not', () => {
      expect(parseInstant(new Date('2026-09-07T14:00:00Z')).toISOString()).toBe('2026-09-07T14:00:00.000Z');
      expect(() => parseInstant(new Date('nonsense'))).toThrow(TimeError);
    });

    it('the returned Date is a copy — a caller mutating it cannot corrupt the source', () => {
      const source = new Date('2026-09-07T14:00:00Z');
      const parsed = parseInstant(source);
      parsed.setTime(0);
      expect(source.toISOString()).toBe('2026-09-07T14:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  describe('civil time resolves through a zone, and DST is not smoothed over', () => {
    it('the same wall clock is a different instant in summer and winter', () => {
      const summer = civilToInstant(civil(2026, 7, 1, 14, 30), 'Europe/London');
      const winter = civilToInstant(civil(2026, 1, 15, 14, 30), 'Europe/London');
      expect(summer.ok).toBe(true);
      expect(winter.ok).toBe(true);
      if (summer.ok === true && winter.ok === true) {
        expect(summer.instant.toISOString()).toBe('2026-07-01T13:30:00.000Z');
        expect(winter.instant.toISOString()).toBe('2026-01-15T14:30:00.000Z');
        expect(summer.offsetMinutes).toBe(60);
        expect(winter.offsetMinutes).toBe(0);
      }
    });

    it('a time inside the spring-forward gap is REFUSED, not nudged into existence', () => {
      for (const [zone, when] of [
        ['Europe/London', civil(2026, 3, 29, 1, 30)],
        ['America/New_York', civil(2026, 3, 8, 2, 30)],
      ] as const) {
        const result = civilToInstant(when, zone);
        expect(result.ok).toBe(false);
        if (result.ok === false) {
          expect(result.reason).toBe('NONEXISTENT_LOCAL_TIME');
          expect(result.candidates).toHaveLength(0);
          expect(result.detail).toContain('does not exist');
        }
      }
    });

    it('a time inside the fall-back overlap returns BOTH instants and picks neither', () => {
      const result = civilToInstant(civil(2026, 10, 25, 1, 30), 'Europe/London');
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('AMBIGUOUS_LOCAL_TIME');
        expect(result.candidates.map((d) => d.toISOString())).toEqual([
          '2026-10-25T00:30:00.000Z',
          '2026-10-25T01:30:00.000Z',
        ]);
        // Exactly one hour apart, and both are real. Silently taking the first would put a
        // meeting an hour from where the customer expects it, once a year.
        expect(result.candidates[1].getTime() - result.candidates[0].getTime()).toBe(3_600_000);
      }
    });

    it('the overlap is detected even though the naive instant already sits past the transition', () => {
      // This is the bug the first implementation had. Probing only at the naive UTC instant
      // reports the post-transition offset, resolves cleanly, and never generates the second
      // candidate — so an ambiguous time was reported as unambiguous. Measured, then fixed.
      const naive = new Date(Date.UTC(2026, 9, 25, 1, 30));
      expect(offsetMinutesAt(naive, 'Europe/London')).toBe(0);
      expect(offsetMinutesAt(new Date(naive.getTime() - 86_400_000), 'Europe/London')).toBe(60);
      const result = civilToInstant(civil(2026, 10, 25, 1, 30), 'Europe/London');
      expect(result.ok).toBe(false);
    });

    it('a half-hour DST shift is handled — Lord Howe moves by 30 minutes, not 60', () => {
      const result = civilToInstant(civil(2026, 4, 5, 1, 45), 'Australia/Lord_Howe');
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe('AMBIGUOUS_LOCAL_TIME');
        expect(result.candidates[1].getTime() - result.candidates[0].getTime()).toBe(1_800_000);
      }
    });

    it('a zone with no DST at all resolves every civil time exactly once', () => {
      for (const month of [1, 4, 7, 10]) {
        const result = civilToInstant(civil(2026, month, 15, 1, 30), 'Asia/Dhaka');
        expect(result.ok).toBe(true);
        if (result.ok === true) expect(result.offsetMinutes).toBe(360);
      }
    });

    it('zonedFields reads the zone’s weekday, not the machine’s', () => {
      // 21:00 UTC on a Sunday is already Monday in Dhaka. A machine-local getDay() would
      // disagree with one of these two, depending where it runs.
      const instant = parseInstant('2026-09-06T21:00:00Z');
      expect(zonedFields(instant, 'Europe/London').weekday).toBe(0);
      expect(zonedFields(instant, 'Asia/Dhaka').weekday).toBe(1);
    });

    it('civilToInstant refuses a zone it cannot trust', () => {
      expect(() => civilToInstant(civil(2026, 7, 1, 14, 0), 'BST')).toThrow(TimeError);
    });
  });

  // -------------------------------------------------------------------------
  describe('the datetime-local round trip', () => {
    it('survives 1500 instants across three zones and a full year', () => {
      // The old code lost 360 minutes on every trip. This asserts the property directly:
      // render an instant into the field, read it back, get the same instant.
      let lost = 0;
      let ambiguous = 0;
      for (const zone of ['Europe/London', 'America/New_York', 'Asia/Dhaka']) {
        for (let i = 0; i < 500; i++) {
          const instant = new Date(Date.UTC(2026, 0, 1) + i * 17 * 3600 * 1000);
          const back = fromDateTimeLocalValue(toDateTimeLocalValue(instant, zone), zone);
          if (back.ok === true) {
            if (back.instant.getTime() !== instant.getTime()) lost++;
          } else if (back.reason === 'AMBIGUOUS_LOCAL_TIME') {
            ambiguous++;
            // Even here the instant must be one of the offered candidates.
            if (!back.candidates.some((c) => c.getTime() === instant.getTime())) lost++;
          } else {
            lost++;
          }
        }
      }
      expect(lost).toBe(0);
      // A rendered wall clock genuinely names two instants once a year; that is the zone's
      // property, not a bug, and the round trip reports it rather than hiding it.
      expect(ambiguous).toBeLessThan(5);
    });

    it('renders in the MEETING’s zone, so the same instant reads differently', () => {
      const instant = parseInstant('2026-07-01T13:30:00Z');
      expect(toDateTimeLocalValue(instant, 'Europe/London')).toBe('2026-07-01T14:30');
      expect(toDateTimeLocalValue(instant, 'Asia/Dhaka')).toBe('2026-07-01T19:30');
      expect(toDateTimeLocalValue(instant, 'UTC')).toBe('2026-07-01T13:30');
    });

    it('the old double-conversion is demonstrably wrong and this one is not', () => {
      const instant = parseInstant('2026-07-01T13:30:00Z');
      // What the modal used to do: toISOString().slice(0,16), then new Date() on submit.
      const oldRendered = instant.toISOString().slice(0, 16);
      expect(oldRendered).toBe('2026-07-01T13:30');
      // …which displays 13:30 to a London operator who chose 14:30, and re-parses as local.
      expect(toDateTimeLocalValue(instant, 'Europe/London')).toBe('2026-07-01T14:30');
      expect(toDateTimeLocalValue(instant, 'Europe/London')).not.toBe(oldRendered);
    });

    it('a malformed field value throws rather than resolving to something', () => {
      for (const bad of ['', 'tomorrow', '2026-07-01', '2026-07-01 14:30', '07/01/2026T14:30']) {
        expect(() => fromDateTimeLocalValue(bad, 'Europe/London')).toThrow(TimeError);
      }
    });

    it('31 February is refused rather than rolled into March', () => {
      // Date.UTC(2026, 1, 31) silently becomes 3 March. The round-trip check catches it.
      expect(() => fromDateTimeLocalValue('2026-02-31T14:30', 'Europe/London')).toThrow(TimeError);
    });

    it('the pattern accepts exactly the HTML value shape', () => {
      expect(DATE_TIME_LOCAL_PATTERN.test('2026-07-01T14:30')).toBe(true);
      expect(DATE_TIME_LOCAL_PATTERN.test('2026-07-01T14:30:15')).toBe(true);
      expect(DATE_TIME_LOCAL_PATTERN.test('2026-07-01T14:30Z')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('business hours are zone-aware', () => {
    it('the same instant is inside hours in one zone and outside in another', () => {
      // 15:00 UTC on a Monday is 16:00 in London (open) and 21:00 in Dhaka (long shut). The
      // instant is identical; only the zone the hours are read in differs.
      const instant = parseInstant('2026-09-07T15:00:00Z');
      const london = isWithinBusinessHours(instant, DEFAULT_BUSINESS_HOURS);
      const dhaka = isWithinBusinessHours(instant, { ...DEFAULT_BUSINESS_HOURS, timeZone: 'Asia/Dhaka' });
      expect(london.within).toBe(true);
      expect(dhaka.within).toBe(false);
      if (dhaka.within === false) expect(dhaka.reason).toBe('AFTER_CLOSE');
    });

    it('the same instant lands on different WEEKDAYS in different zones', () => {
      // 21:00 UTC on Sunday is still Sunday in London (closed) but already Monday 03:00 in
      // Dhaka (before open). A machine-local getDay() would agree with at most one of them.
      const instant = parseInstant('2026-09-06T21:00:00Z');
      const london = isWithinBusinessHours(instant, DEFAULT_BUSINESS_HOURS);
      const dhaka = isWithinBusinessHours(instant, { ...DEFAULT_BUSINESS_HOURS, timeZone: 'Asia/Dhaka' });
      expect(london.within).toBe(false);
      expect(dhaka.within).toBe(false);
      if (london.within === false) expect(london.reason).toBe('CLOSED_DAY');
      if (dhaka.within === false) expect(dhaka.reason).toBe('BEFORE_OPEN');
    });

    it('a weekend is closed, and says so', () => {
      const saturday = isWithinBusinessHours(parseInstant('2026-09-05T11:00:00Z'));
      expect(saturday.within).toBe(false);
      if (saturday.within === false) expect(saturday.reason).toBe('CLOSED_DAY');
    });

    it('before open and after close are distinguished, not merged into "no"', () => {
      const early = isWithinBusinessHours(parseInstant('2026-09-07T06:00:00Z')); // 07:00 BST
      const late = isWithinBusinessHours(parseInstant('2026-09-07T18:00:00Z')); // 19:00 BST
      expect(early.within).toBe(false);
      expect(late.within).toBe(false);
      if (early.within === false) expect(early.reason).toBe('BEFORE_OPEN');
      if (late.within === false) expect(late.reason).toBe('AFTER_CLOSE');
    });

    it('close is exclusive: 17:30 is shut, 17:29 is open', () => {
      expect(isWithinBusinessHours(parseInstant('2026-09-07T16:29:00Z')).within).toBe(true);
      expect(isWithinBusinessHours(parseInstant('2026-09-07T16:30:00Z')).within).toBe(false);
    });

    it('Friday closes earlier than Thursday, and the difference is honoured', () => {
      expect(isWithinBusinessHours(parseInstant('2026-09-03T16:15:00Z')).within).toBe(true); // Thu 17:15
      expect(isWithinBusinessHours(parseInstant('2026-09-04T16:15:00Z')).within).toBe(false); // Fri 17:15
    });

    it('a holiday closes the day regardless of weekday', () => {
      const hours = { ...DEFAULT_BUSINESS_HOURS, holidays: ['2026-09-07'] };
      const verdict = isWithinBusinessHours(parseInstant('2026-09-07T10:00:00Z'), hours);
      expect(verdict.within).toBe(false);
      if (verdict.within === false) expect(verdict.reason).toBe('HOLIDAY');
    });

    it('the holiday date is the LOCAL date, not the UTC one', () => {
      // 23:30 UTC on the 7th is already the 8th in Dhaka. A UTC-keyed holiday list would
      // close the wrong day for half the world.
      const hours = { ...DEFAULT_BUSINESS_HOURS, timeZone: 'Asia/Dhaka', holidays: ['2026-09-08'] };
      const fields = zonedFields(parseInstant('2026-09-07T23:30:00Z'), 'Asia/Dhaka');
      expect(localDateKey(fields)).toBe('2026-09-08');
      expect(isWithinBusinessHours(parseInstant('2026-09-07T23:30:00Z'), hours).within).toBe(false);
    });

    it('a window must be a real interval inside one day', () => {
      expect(() => dayWindow(17 * 60, 9 * 60)).toThrow(TimeError);
      expect(() => dayWindow(-60, 600)).toThrow(TimeError);
      expect(() => dayWindow(0, 2000)).toThrow(TimeError);
      expect(() => dayWindow(9.5, 600)).toThrow(TimeError);
    });
  });

  // -------------------------------------------------------------------------
  describe('nextBusinessSlot', () => {
    it('skips the weekend rather than proposing a Saturday', () => {
      // The composer's old `getDate() + 2` did exactly this, with no check at all.
      const slot = nextBusinessSlot(parseInstant('2026-09-04T20:00:00Z'), { minLeadMinutes: 60 });
      expect(slot).not.toBeNull();
      if (slot !== null) {
        expect(slot.toISOString()).toBe('2026-09-07T08:00:00.000Z');
        expect(zonedFields(slot, 'Europe/London').weekday).toBe(1);
      }
    });

    it('respects the lead time', () => {
      const soon = nextBusinessSlot(parseInstant('2026-09-07T08:00:00Z'), { minLeadMinutes: 0 });
      const later = nextBusinessSlot(parseInstant('2026-09-07T08:00:00Z'), { minLeadMinutes: 2 * 24 * 60 });
      expect(soon).not.toBeNull();
      expect(later).not.toBeNull();
      if (soon !== null && later !== null) {
        expect(later.getTime()).toBeGreaterThan(soon.getTime());
        expect(later.getTime() - parseInstant('2026-09-07T08:00:00Z').getTime()).toBeGreaterThanOrEqual(
          2 * 24 * 60 * 60_000
        );
      }
    });

    it('leaves room for the meeting: a 60-minute meeting cannot start at 17:00 on a Friday', () => {
      const friday = parseInstant('2026-09-04T15:30:00Z'); // 16:30 BST, Friday closes 17:00
      const long = nextBusinessSlot(friday, { durationMinutes: 60, slotMinutes: 15 });
      expect(long).not.toBeNull();
      if (long !== null) expect(zonedFields(long, 'Europe/London').weekday).toBe(1); // pushed to Monday
    });

    it('steps by calendar day across a DST change, not by 86 400 000 ms', () => {
      // Europe/London falls back on 2026-10-25. Monday 09:00 local is 08:00Z before the change
      // and 09:00Z after it. Fixed-millisecond stepping drifts an hour and lands off-boundary.
      const slot = nextBusinessSlot(parseInstant('2026-10-23T20:00:00Z'), { minLeadMinutes: 60 });
      expect(slot).not.toBeNull();
      if (slot !== null) {
        expect(slot.toISOString()).toBe('2026-10-26T09:00:00.000Z');
        const local = zonedFields(slot, 'Europe/London');
        expect(local.hour).toBe(9);
        expect(local.minute).toBe(0);
        expect(local.offsetMinutes).toBe(0); // GMT again
      }
    });

    it('every proposed slot is itself inside business hours', () => {
      let cursor = parseInstant('2026-01-01T00:00:00Z');
      for (let i = 0; i < 60; i++) {
        const slot = nextBusinessSlot(cursor, { minLeadMinutes: 90, durationMinutes: 30 });
        expect(slot).not.toBeNull();
        if (slot === null) break;
        expect(isWithinBusinessHours(slot, DEFAULT_BUSINESS_HOURS).within).toBe(true);
        cursor = new Date(slot.getTime() + 6 * 3600 * 1000);
      }
    });

    it('a business that is never open returns null instead of looping forever', () => {
      const never = { ...DEFAULT_BUSINESS_HOURS, days: [null, null, null, null, null, null, null] };
      expect(nextBusinessSlot(parseInstant('2026-09-07T08:00:00Z'), { hours: never })).toBeNull();
    });

    it('an invalid slot size is refused rather than silently corrected', () => {
      expect(() => nextBusinessSlot(new Date(), { slotMinutes: 0 })).toThrow(TimeError);
      expect(() => nextBusinessSlot(new Date(), { slotMinutes: -15 })).toThrow(TimeError);
      expect(() => nextBusinessSlot(new Date(), { slotMinutes: 7.5 })).toThrow(TimeError);
    });
  });

  // -------------------------------------------------------------------------
  describe('a meeting keeps the zone it was agreed in', () => {
    it('stores both halves', () => {
      const value = scheduledTime(parseInstant('2026-07-01T13:30:00Z'), 'Europe/London');
      expect(value.startAtUtc).toBe('2026-07-01T13:30:00.000Z');
      expect(value.timeZone).toBe('Europe/London');
      expect(scheduledInstant(value).getTime()).toBe(parseInstant('2026-07-01T13:30:00Z').getTime());
    });

    it('can restate the same meeting in another party’s terms', () => {
      const value = scheduledTime(parseInstant('2026-07-01T13:30:00Z'), 'Europe/London');
      expect(describeScheduledTime(value)).toContain('14:30');
      expect(describeScheduledTime(value)).toContain('Europe/London');
      expect(describeScheduledTime(value, 'Asia/Dhaka')).toContain('19:30');
      // Which is the whole point of keeping the zone: the instant alone cannot do this
      // sentence, because it does not know what was agreed.
    });

    it('refuses to record a meeting against an abbreviation', () => {
      expect(() => scheduledTime(new Date(), 'BST')).toThrow(TimeError);
    });
  });

  // -------------------------------------------------------------------------
  describe('reading a stored instant back — the defect a runtime probe found', () => {
    /**
     * `GET /api/meetings` called `.toISOString()` on the value Firestore returned. Firestore
     * returns a `Timestamp`, which has `toMillis()` and `toDate()` and no `toISOString()`, so
     * the call produced `undefined` and the endpoint answered 200 with an empty field.
     *
     * Neither the compiler nor the suite could see it: the snapshot value is `any`, and no test
     * round-tripped through the store. It took sending a real request and reading the response.
     */
    const firestoreTimestamp = (iso: string) => ({
      toMillis: () => new Date(iso).getTime(),
      toDate: () => new Date(iso),
    });

    it('a Firestore Timestamp renders, where toISOString() silently produced undefined', () => {
      const stored = firestoreTimestamp('2026-09-08T13:30:00Z');
      expect((stored as { toISOString?: unknown }).toISOString).toBeUndefined();
      expect(toIsoOrNull(stored)).toBe('2026-09-08T13:30:00.000Z');
    });

    it('a Timestamp exposing only toDate still renders', () => {
      expect(toIsoOrNull({ toDate: () => new Date('2026-09-08T13:30:00Z') })).toBe(
        '2026-09-08T13:30:00.000Z'
      );
    });

    it('a Date, an ISO string and epoch millis all render', () => {
      expect(toIsoOrNull(new Date('2026-09-08T13:30:00Z'))).toBe('2026-09-08T13:30:00.000Z');
      expect(toIsoOrNull('2026-09-08T13:30:00Z')).toBe('2026-09-08T13:30:00.000Z');
      expect(toIsoOrNull(new Date('2026-09-08T13:30:00Z').getTime())).toBe('2026-09-08T13:30:00.000Z');
    });

    it('missing and unusable values give null, never a fabricated instant', () => {
      // null is honest; a default of "now" would put a meeting on today's date silently.
      for (const bad of [null, undefined, '', 'tomorrow', {}, NaN, new Date('nonsense')]) {
        expect(toIsoOrNull(bad)).toBeNull();
      }
    });

    it('an offset-less stored string is refused rather than read as machine-local', () => {
      expect(toIsoOrNull('2026-09-08T14:30')).toBeNull();
    });

    it('the meetings endpoint uses it', () => {
      const server = readFileSync('server.ts', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(server).toContain('scheduledAt: toIsoOrNull(m.startAtUtc ?? m.scheduledTime)');
      expect(server).not.toContain('m.scheduledTime.toISOString()');
    });
  });

  // -------------------------------------------------------------------------
  describe('the clock is injectable', () => {
    it('a fixed clock does not move', () => {
      const clock = fixedClock('2026-03-29T00:30:00Z');
      const first = clock.now().getTime();
      for (let i = 0; i < 1000; i++) clock.now();
      expect(clock.now().getTime()).toBe(first);
      expect(clock.now().toISOString()).toBe('2026-03-29T00:30:00.000Z');
    });

    it('a fixed clock hands out copies, so a caller cannot advance it', () => {
      const clock = fixedClock('2026-07-01T12:00:00Z');
      clock.now().setTime(0);
      expect(clock.now().toISOString()).toBe('2026-07-01T12:00:00.000Z');
    });

    it('a fixed clock refuses an offset-less instant', () => {
      expect(() => fixedClock('2026-07-01T12:00')).toThrow(TimeError);
      expect(() => fixedClock(new Date('nonsense'))).toThrow(TimeError);
    });

    it('the system clock moves and is a Clock', () => {
      const before = Date.now();
      const reading = systemClock.now();
      expect(reading.getTime()).toBeGreaterThanOrEqual(before);
      const asInterface: Clock = systemClock;
      expect(typeof asInterface.now).toBe('function');
    });

    it('a frozen clock makes the DST boundary testable at all', () => {
      // The point of injection: this assertion is only possible because the caller chose when
      // "now" is. A function reading Date.now() internally passes in June and fails in October.
      const springForward = fixedClock('2026-03-29T00:30:00Z');
      const slot = nextBusinessSlot(springForward.now(), { minLeadMinutes: 0 });
      expect(slot).not.toBeNull();
      if (slot !== null) expect(isWithinBusinessHours(slot).within).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('the module reads no wall clock and no machine zone of its own', () => {
    const source = readFileSync('shared/domain/time.ts', 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('only systemClock reads the wall clock', () => {
      const reads = code.match(/new Date\(\)|Date\.now\(\)/g) || [];
      expect(reads).toHaveLength(1);
      expect(code).toContain('now: (): Date => new Date(),');
    });

    it('it never calls a local-zone Date method', () => {
      expect(code).not.toMatch(/\.(setHours|getHours|getDay|getMonth|getFullYear|getTimezoneOffset)\s*\(/);
    });

    it('it never asks the machine what zone it is in', () => {
      expect(code).not.toContain('resolvedOptions()');
    });
  });

  // -------------------------------------------------------------------------
  describe('the live paths actually use it — a module that exists is not a module that is called', () => {
    const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('every schema timestamp column carries a zone', () => {
      const schema = readFileSync('server/db/schema.ts', 'utf8');
      const total = (schema.match(/timestamp\('[a-z0-9_]+'/g) || []).length;
      const zoned = (schema.match(/withTimezone: true/g) || []).length;
      // 76 -> 78: `documents.created_at` and `documents.updated_at`, added when the
      // Firestore collections moved into PostgreSQL. Both are timestamptz, which is the
      // property this ratchet exists to hold; the number moves, the rule does not.
      expect(total).toBe(78);
      expect(zoned).toBe(total);
      expect(schema).not.toMatch(/timestamp\('[a-z0-9_]+'\)/);
    });

    it('the meetings table stores {startAtUtc, timeZone}, not a bare instant', () => {
      const schema = readFileSync('server/db/schema.ts', 'utf8');
      expect(schema).toContain("startAtUtc: timestamp('start_at_utc', { withTimezone: true })");
      expect(schema).toContain("timeZone: varchar('time_zone', { length: 64 })");
    });

    it('POST /api/meetings requires an instant with an offset and a real zone', () => {
      const server = strip(readFileSync('server.ts', 'utf8'));
      expect(server).toContain('startInstant = parseInstant(scheduledTime)');
      expect(server).toContain('const zoneRejection = timeZoneRejection(timeZone)');
      expect(server).toContain('isWithinBusinessHours(startInstant, DEFAULT_BUSINESS_HOURS)');
      // The old line read the offset-less string as server-local.
      expect(server).not.toContain('const startMs = new Date(scheduledTime).getTime()');
    });

    it('the meetings payload persists the zone', () => {
      const server = strip(readFileSync('server.ts', 'utf8'));
      expect(server).toContain('startAtUtc: new Date(startMs)');
      expect(server).toContain('timeZone: timeZone');
    });

    it('nextBusinessSlot has NO live caller, and that is recorded rather than disguised', () => {
      // This asserted that the reply composer proposed a slot with `nextBusinessSlot`. It did —
      // inside `executeMultiAgentReplyPipeline`, which nothing called. P1.9's slotting was a
      // capability the repository held and the running system did not have, and this test read
      // as proof that it did.
      //
      // The dead composer is removed (S21), so the function now has no caller at all. Inventing
      // one to keep a green test would be worse than the original defect: it would put a
      // proposed meeting time in front of a customer that nothing downstream honours.
      //
      // `nextBusinessSlot` keeps its own invariant tests above — the DST, lookahead and
      // business-hours behaviour is still fully covered — and waits for a caller that means it.
      const composer = strip(readFileSync('server/agents/multiAgentReplySystem.ts', 'utf8'));
      expect(composer).not.toContain('nextBusinessSlot(');
      expect(composer).not.toMatch(/targetDate\.setHours\(/);
      expect(composer).not.toMatch(/targetDate\.setDate\(/);

      // The claim above, checked rather than asserted in prose: if something starts calling it,
      // this fails and whoever wired it must replace this test with a real behavioural one.
      const callers: string[] = [];
      for (const file of productionSourceFiles()) {
        // The declaration is not a call. Removing it first is what makes the count mean
        // "somebody uses this" rather than "this exists".
        const text = strip(readFileSync(file, 'utf8')).replace(
          /export function nextBusinessSlot\s*\(/g,
          'DECLARATION('
        );
        if (/\bnextBusinessSlot\s*\(/.test(text)) callers.push(file);
      }
      expect(callers).toEqual([]);
    });

    it('the modal resolves the civil time in a named zone before submitting', () => {
      const modal = strip(readFileSync('src/components/ScheduleMeetingModal.tsx', 'utf8'));
      expect(modal).toContain('fromDateTimeLocalValue(scheduledTime, timeZone)');
      expect(modal).toContain('toDateTimeLocalValue(');
      expect(modal).toContain('timeZone,');
      // The double conversion, both halves.
      expect(modal).not.toContain('toISOString().slice(0, 16)');
      expect(modal).not.toContain('new Date(scheduledTime).toISOString()');
    });

    it('validateBusinessHours no longer returns true for everything', () => {
      // Migrated 2026-09-07: this asserted the source text `isWithinBusinessHours(startTime,
      // hours)`, which stopped matching when the adapter began forcing the caller's zone onto
      // the hours (`{ ...hours, timeZone }`) — a change that makes the function MORE correct.
      // A test pinned to an argument list fails when the argument list improves, so it now
      // exercises the behaviour instead: the same instant is inside business hours in one zone
      // and outside them in another, which no `return true` can produce.
      const svc = new GoogleCalendarService();
      const nineAmLondon = new Date('2026-07-01T09:00:00.000Z');
      expect(svc.validateBusinessHours(nineAmLondon, 'Europe/London').valid).toBe(true);
      expect(svc.validateBusinessHours(nineAmLondon, 'Asia/Tokyo').valid).toBe(false);
    });

    it('availability is three-valued and UNKNOWN is reachable', () => {
      // Claiming "free" from a function that never contacted a provider is a fabricated
      // success (§39) wearing a boolean. `checkFreeBusy` used to return a hardcoded UNKNOWN
      // because it contacted nothing; it is now a real free/busy call, so the assertion moved
      // from "it says UNKNOWN" to "it says UNKNOWN when it cannot read the answer" — which is
      // a claim about behaviour rather than about a string in the file.
      const calendar = strip(readFileSync('server/services/calendar.service.ts', 'utf8'));
      expect(calendar).toContain('implements CalendarProvider');
      expect(calendar).toContain("availability: 'UNKNOWN'");
      expect(calendar).toContain("availability: 'BUSY'");
      expect(calendar).toContain("availability: 'FREE'");
      // The runtime proof of the UNKNOWN branch lives in calendarContract.invariant.test.ts,
      // which drives the adapter against a stubbed transport that returns per-calendar errors.
      expect(calendar).not.toMatch(/checkAvailability[\s\S]{0,300}?return true;/);
    });
  });

  // -------------------------------------------------------------------------
  describe('formatting helpers', () => {
    it('formatCivil pads and omits a zero second', () => {
      expect(formatCivil(civil(2026, 7, 1, 9, 5))).toBe('2026-07-01 09:05');
      expect(formatCivil({ ...civil(2026, 7, 1, 9, 5), second: 30 })).toBe('2026-07-01 09:05:30');
    });

    it('localDateKey is stable and zero-padded', () => {
      expect(localDateKey(civil(2026, 1, 2, 0, 0))).toBe('2026-01-02');
    });
  });
});

/** Every production .ts under server/ and shared/ — tests and build output excluded. */
function productionSourceFiles(): string[] {
  const out: string[] = [];
  const skip = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'tests']);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/.ts$/.test(entry) && !/.test.ts$/.test(entry)) out.push(full);
    }
  };
  walk('server');
  walk('shared');
  return out;
}
