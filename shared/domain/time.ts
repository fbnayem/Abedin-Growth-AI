/**
 * P1.9 — Time correctness.
 *
 * Four defects were measured in this repository before this module existed, on a machine whose
 * system zone is Asia/Dhaka (UTC+6):
 *
 *  1. `targetDate.setHours(14, 30, 0, 0); // 2:30 PM BST` in the reply composer produced
 *     09:30 in Europe/London. `setHours` writes the *machine's* wall clock, and the machine is
 *     not in London. The comment was a claim about the code that the code did not implement.
 *
 *  2. `"BST"` is accepted by `Intl.DateTimeFormat` and canonicalises to **Asia/Dhaka**, because
 *     British Summer Time and Bangladesh Standard Time share the abbreviation. Those two zones
 *     are five hours apart. Intl accepting a string is therefore NOT evidence that the string
 *     names the zone somebody meant.
 *
 *  3. The scheduling modal did `date.setHours(14,0)` then `.toISOString().slice(0,16)` to fill a
 *     `datetime-local` field, and `new Date(value)` to read it back. The first converts local to
 *     UTC, the second parses an offset-less string as local: the offset is applied twice in the
 *     same direction. Measured drift on this machine: -360 minutes.
 *
 *  4. `new Date("2026-09-07T14:00")` and `new Date("2026-09-07T14:00Z")` are six hours apart
 *     here, and `POST /api/meetings` accepted both into the same field.
 *
 * The rules this module enforces:
 *
 *   - An instant and a civil time are different types. An instant is a point on the timeline; a
 *     civil time is "14:30 on the 8th", which is not a point until a zone resolves it.
 *   - A zone is an IANA identifier, exact-cased, and nothing else. Not an abbreviation, not a
 *     fixed offset — an offset cannot express a DST transition, so a meeting booked across one
 *     is wrong by an hour.
 *   - A civil time that does not exist (spring-forward gap) or exists twice (fall-back overlap)
 *     is not resolved by guessing. §14: unknown must never default to permission, and a booking
 *     is a permission. The caller is told which it is, and refuses or asks.
 *   - Wall-clock reads are injected. A function that calls `Date.now()` internally cannot be
 *     tested against a DST boundary, which is exactly where these bugs live.
 */

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

/** The real clock. The only value in the codebase that should read the wall clock by default. */
export const systemClock: Clock = Object.freeze({
  now: (): Date => new Date(),
});

/**
 * A clock frozen at one instant. Tests use this to stand on a DST boundary and stay there;
 * a test that reads the real clock passes in June and fails in October.
 */
export function fixedClock(instant: Date | string): Clock {
  const at = typeof instant === 'string' ? parseInstant(instant) : instant;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TimeError('INVALID_INSTANT', `fixedClock needs a valid instant, got ${String(instant)}`);
  }
  const ms = at.getTime();
  return Object.freeze({ now: (): Date => new Date(ms) });
}

export class TimeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TimeError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/**
 * `Intl.supportedValuesOf('timeZone')` is the canonical IANA list. Membership — not "Intl did
 * not throw" — is the test, because Intl silently accepts `BST`, `EST`, `US/Eastern`, `+01:00`
 * and lowercase spellings, and resolves some of them to a zone on the other side of the world.
 *
 * `UTC` is the one addition: it is universally meant, and it is absent from the supported list.
 */
const IANA_ZONES: ReadonlySet<string> = new Set([
  ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
  'UTC',
]);

/** Strings Intl accepts that this system refuses, with the reason, so an error can say why. */
export const REJECTED_ZONE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  ABBREVIATION:
    'Time-zone abbreviations are ambiguous. "BST" names both British Summer Time and Bangladesh ' +
    'Standard Time, five hours apart, and Intl silently resolves it to Asia/Dhaka. Use an IANA ' +
    'identifier such as Europe/London.',
  FIXED_OFFSET:
    'A fixed offset cannot express a daylight-saving transition, so any instant computed from ' +
    'it is wrong by an hour for half the year. Use an IANA identifier.',
  UNKNOWN: 'Not an IANA time-zone identifier.',
  CASE:
    'IANA identifiers are case-sensitive as stored. Use the canonical spelling so that two ' +
    'records naming the same zone compare equal.',
});

const FIXED_OFFSET_PATTERN = /^[+-]\d{2}(:?\d{2})?$/;

export function isValidTimeZone(zone: unknown): zone is string {
  return typeof zone === 'string' && IANA_ZONES.has(zone);
}

/** Why a zone was refused — used to give the operator a message they can act on. */
export function timeZoneRejection(zone: unknown): string | null {
  if (isValidTimeZone(zone)) return null;
  if (typeof zone !== 'string' || zone.length === 0) return REJECTED_ZONE_REASONS.UNKNOWN;
  if (FIXED_OFFSET_PATTERN.test(zone)) return REJECTED_ZONE_REASONS.FIXED_OFFSET;
  if (/^[A-Za-z]{2,5}$/.test(zone)) return REJECTED_ZONE_REASONS.ABBREVIATION;
  for (const known of IANA_ZONES) {
    if (known.toLowerCase() === zone.toLowerCase()) return REJECTED_ZONE_REASONS.CASE;
  }
  return REJECTED_ZONE_REASONS.UNKNOWN;
}

export function assertTimeZone(zone: unknown): string {
  const rejection = timeZoneRejection(zone);
  if (rejection !== null) {
    throw new TimeError('INVALID_TIME_ZONE', `${JSON.stringify(zone)} is not usable: ${rejection}`);
  }
  return zone as string;
}

/** The list, for a picker. Sorted so the UI does not have to care. */
export function supportedTimeZones(): string[] {
  return [...IANA_ZONES].sort();
}

// ---------------------------------------------------------------------------
// Instants
// ---------------------------------------------------------------------------

/**
 * ISO-8601 with a MANDATORY offset. `2026-09-07T14:00` is refused rather than read as the
 * machine's local time — that silent reading is defect 4 above.
 */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value: unknown): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TimeError('INVALID_INSTANT', 'Invalid Date.');
    return new Date(value.getTime());
  }
  if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) {
    throw new TimeError(
      'INVALID_INSTANT',
      `${JSON.stringify(value)} is not an instant. An instant needs an offset (Z or +01:00); ` +
        'without one the same string means different moments on different machines.'
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TimeError('INVALID_INSTANT', `${JSON.stringify(value)} is not a real date.`);
  }
  // `new Date("2026-02-31T14:00:00Z")` does not fail — it returns 3 March. Without this check
  // the meetings route would accept a 31 February booking and quietly move it to March, and the
  // only trace would be a customer who turned up on the wrong day.
  //
  // The calendar is checked from the DIGITS, not by comparing against the parsed UTC date:
  // with a `+01:00` offset the UTC date legitimately differs from the written one, so that
  // comparison would have to exempt every offset form — and would then let
  // `2026-02-31T14:00:00+01:00` straight through.
  const [datePart] = value.replace(' ', 'T').split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  if (!isRealCalendarDate(year, month, day)) {
    throw new TimeError(
      'INVALID_INSTANT',
      `${JSON.stringify(value)} is not a real date: ${datePart} is not a day in the calendar.`
    );
  }
  return parsed;
}

/**
 * Whether these digits name a day that exists. `Date.UTC(2026, 1, 31)` answers 3 March without
 * complaint, so every entry point checks the digits before trusting arithmetic on them.
 */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
  );
}

export function tryParseInstant(value: unknown): Date | null {
  try {
    return parseInstant(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Civil time in a zone
// ---------------------------------------------------------------------------

export interface CivilDateTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

export interface ZonedFields extends CivilDateTime {
  /** 0 = Sunday to 6 = Saturday, in the zone — not on the machine. */
  weekday: number;
  offsetMinutes: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(zone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      era: 'short',
    });
    formatterCache.set(zone, cached);
  }
  return cached;
}

/** Truncate to whole seconds; Date.UTC from formatted parts carries no milliseconds. */
function toSeconds(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** The wall-clock reading a person in `zone` sees at `instant`. */
export function zonedFields(instant: Date, zone: string): ZonedFields {
  assertTimeZone(zone);
  const parts = partsFormatter(zone).formatToParts(instant);
  const get = (type: string): string => {
    const found = parts.find((p) => p.type === type);
    return found === undefined ? '' : found.value;
  };
  const era = get('era');
  // A BC year would make Date.UTC's year arithmetic silently wrong; nothing here is that old.
  if (era !== '' && era !== 'AD') {
    throw new TimeError('OUT_OF_RANGE', `Instant falls outside the common era in ${zone}.`);
  }
  const civil: CivilDateTime = {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  const offsetMinutes = (asIfUtc - toSeconds(instant.getTime())) / 60_000;
  const weekday = WEEKDAY_INDEX[get('weekday')];
  if (weekday === undefined) {
    throw new TimeError('OUT_OF_RANGE', `Could not read a weekday for ${zone}.`);
  }
  return { ...civil, weekday, offsetMinutes };
}

/** Minutes east of UTC at that instant in that zone. Varies across the year by design. */
export function offsetMinutesAt(instant: Date, zone: string): number {
  return zonedFields(instant, zone).offsetMinutes;
}

export type CivilResolution =
  | { readonly ok: true; readonly instant: Date; readonly offsetMinutes: number }
  | {
      readonly ok: false;
      readonly reason: 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME';
      /** For AMBIGUOUS: the real instants, earliest first. For NONEXISTENT: empty. */
      readonly candidates: readonly Date[];
      readonly detail: string;
    };

function sameCivil(a: CivilDateTime, b: CivilDateTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * "14:30 on the 8th, in Europe/London" -> a point on the timeline.
 *
 * Two civil times a year have no single answer, and this returns neither a guess nor a throw:
 *
 *   - The hour skipped at a spring-forward NEVER HAPPENS. Booking a meeting inside it means
 *     booking a meeting at a time that does not exist. Refused.
 *   - The hour repeated at a fall-back happens TWICE, an hour apart. Both instants are returned
 *     and neither is chosen; a caller that silently took the first would put a meeting an hour
 *     from where the customer expects it, once a year, in a way nobody would ever debug.
 */
export function civilToInstant(civil: CivilDateTime, zone: string): CivilResolution {
  assertTimeZone(zone);
  // A date that is not in the calendar is a caller error, not a property of the zone. Without
  // this, 31 February falls out the far end as NONEXISTENT_LOCAL_TIME — technically true, but
  // the message would tell an operator to "pick a time outside the skipped hour" when the real
  // problem is that February has 28 days. The two failures must not be conflated.
  if (!isRealCalendarDate(civil.year, civil.month, civil.day)) {
    throw new TimeError(
      'INVALID_CIVIL',
      `${formatCivil(civil)} is not a day in the calendar.`
    );
  }
  if (
    !Number.isInteger(civil.hour) ||
    !Number.isInteger(civil.minute) ||
    !Number.isInteger(civil.second) ||
    civil.hour < 0 ||
    civil.hour > 23 ||
    civil.minute < 0 ||
    civil.minute > 59 ||
    civil.second < 0 ||
    civil.second > 59
  ) {
    throw new TimeError('INVALID_CIVIL', `${formatCivil(civil)} is not a time of day.`);
  }
  const naiveUtc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute, civil.second);
  if (!Number.isFinite(naiveUtc)) {
    throw new TimeError('OUT_OF_RANGE', 'Civil date is out of the representable range.');
  }

  // Probe a day either side. Any transition near this civil time lies between those two probes,
  // so the two offsets they report are the two the answer can use.
  //
  // Probing only at `naiveUtc` and iterating from there is NOT enough, and it was wrong here
  // before it was measured: for 01:30 on the London fall-back day, the naive instant already
  // sits after the transition, so it reports GMT, resolves to a valid instant, and the second
  // BST candidate is never generated. The overlap was reported as an unambiguous time.
  const DAY_MS = 86_400_000;
  const probeOffsets = new Set<number>([
    offsetMinutesAt(new Date(naiveUtc - DAY_MS), zone),
    offsetMinutesAt(new Date(naiveUtc), zone),
    offsetMinutesAt(new Date(naiveUtc + DAY_MS), zone),
  ]);

  const valid: Date[] = [];
  const seen = new Set<number>();
  for (const offset of probeOffsets) {
    const candidateMs = naiveUtc - offset * 60_000;
    if (seen.has(candidateMs)) continue;
    seen.add(candidateMs);
    // The candidate counts only if it actually reads back as the civil time asked for. This is
    // what rules out the gap: inside it, no instant renders as that wall-clock reading.
    if (sameCivil(zonedFields(new Date(candidateMs), zone), civil)) valid.push(new Date(candidateMs));
  }
  valid.sort((a, b) => a.getTime() - b.getTime());

  if (valid.length === 1) {
    return { ok: true, instant: valid[0], offsetMinutes: offsetMinutesAt(valid[0], zone) };
  }
  if (valid.length === 0) {
    return {
      ok: false,
      reason: 'NONEXISTENT_LOCAL_TIME',
      candidates: [],
      detail:
        `${formatCivil(civil)} does not exist in ${zone}: the clocks move forward across it. ` +
        'Pick a time outside the skipped hour.',
    };
  }
  return {
    ok: false,
    reason: 'AMBIGUOUS_LOCAL_TIME',
    candidates: valid,
    detail:
      `${formatCivil(civil)} happens ${valid.length} times in ${zone}: the clocks move back ` +
      'across it. Say which one, or pick a different time.',
  };
}

export function formatCivil(civil: CivilDateTime): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${pad(civil.year, 4)}-${pad(civil.month)}-${pad(civil.day)} ` +
    `${pad(civil.hour)}:${pad(civil.minute)}` +
    (civil.second === 0 ? '' : `:${pad(civil.second)}`)
  );
}

// ---------------------------------------------------------------------------
// The <input type="datetime-local"> round trip
// ---------------------------------------------------------------------------

export const DATE_TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** What to put in the field so it shows the meeting's time *in the meeting's zone*. */
export function toDateTimeLocalValue(instant: Date, zone: string): string {
  const f = zonedFields(instant, zone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}`;
}

/** Read the field back. The zone is supplied explicitly; it is never the browser's by accident. */
export function fromDateTimeLocalValue(value: string, zone: string): CivilResolution {
  const match = DATE_TIME_LOCAL_PATTERN.exec(String(value ?? ''));
  if (match === null) {
    throw new TimeError('INVALID_CIVIL', `${JSON.stringify(value)} is not a YYYY-MM-DDTHH:mm value.`);
  }
  const civil: CivilDateTime = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] === undefined ? 0 : Number(match[6]),
  };
  // `civilToInstant` rejects a non-calendar date and an impossible time of day by throwing,
  // which is what a caller wants here: the field held something that is not a date at all,
  // as distinct from a real date the zone happens to skip or repeat.
  return civilToInstant(civil, zone);
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export interface DayWindow {
  /** Minutes from local midnight. Half-open: [openMinute, closeMinute). */
  readonly openMinute: number;
  readonly closeMinute: number;
}

export interface BusinessHours {
  readonly timeZone: string;
  /** Index 0 = Sunday to 6 = Saturday. `null` means closed. */
  readonly days: readonly (DayWindow | null)[];
  /** Local calendar dates, `YYYY-MM-DD`, on which the business is closed whatever the weekday. */
  readonly holidays: readonly string[];
}

const MINUTES_PER_DAY = 24 * 60;

export function dayWindow(openMinute: number, closeMinute: number): DayWindow {
  if (!Number.isInteger(openMinute) || !Number.isInteger(closeMinute)) {
    throw new TimeError('INVALID_BUSINESS_HOURS', 'Window bounds must be whole minutes.');
  }
  if (openMinute < 0 || closeMinute > MINUTES_PER_DAY || openMinute >= closeMinute) {
    throw new TimeError(
      'INVALID_BUSINESS_HOURS',
      `[${openMinute}, ${closeMinute}) is not a window inside a single day.`
    );
  }
  return Object.freeze({ openMinute, closeMinute });
}

/**
 * The default is stated, not implied. Whatever the operator's real hours are, they are a
 * configured value in a named zone — and never "whatever the server's clock says".
 */
export const DEFAULT_BUSINESS_HOURS: BusinessHours = Object.freeze({
  timeZone: 'Europe/London',
  days: Object.freeze([
    null, // Sunday
    dayWindow(9 * 60, 17 * 60 + 30),
    dayWindow(9 * 60, 17 * 60 + 30),
    dayWindow(9 * 60, 17 * 60 + 30),
    dayWindow(9 * 60, 17 * 60 + 30),
    dayWindow(9 * 60, 17 * 60), // Friday closes earlier
    null, // Saturday
  ]),
  holidays: Object.freeze([] as string[]),
});

export function localDateKey(fields: CivilDateTime): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(fields.year, 4)}-${pad(fields.month)}-${pad(fields.day)}`;
}

export type BusinessHoursVerdict =
  | { readonly within: true; readonly localTime: string }
  | {
      readonly within: false;
      readonly reason: 'CLOSED_DAY' | 'HOLIDAY' | 'BEFORE_OPEN' | 'AFTER_CLOSE';
      readonly localTime: string;
    };

export function isWithinBusinessHours(
  instant: Date,
  hours: BusinessHours = DEFAULT_BUSINESS_HOURS
): BusinessHoursVerdict {
  const f = zonedFields(instant, hours.timeZone);
  const localTime = `${formatCivil(f)} ${hours.timeZone}`;
  if (hours.holidays.includes(localDateKey(f))) return { within: false, reason: 'HOLIDAY', localTime };
  const window = hours.days[f.weekday];
  if (window === null || window === undefined) return { within: false, reason: 'CLOSED_DAY', localTime };
  const minuteOfDay = f.hour * 60 + f.minute;
  if (minuteOfDay < window.openMinute) return { within: false, reason: 'BEFORE_OPEN', localTime };
  if (minuteOfDay >= window.closeMinute) return { within: false, reason: 'AFTER_CLOSE', localTime };
  return { within: true, localTime };
}

const MAX_LOOKAHEAD_DAYS = 30;

/**
 * The first business-hours instant at or after `after` + `minLeadMinutes`, aligned to a
 * `slotMinutes` boundary, leaving room for a meeting of `durationMinutes`.
 *
 * Bounded: a business with no open day would otherwise loop forever, so it returns null after
 * 30 days rather than hanging a request.
 */
export function nextBusinessSlot(
  after: Date,
  options: {
    hours?: BusinessHours;
    minLeadMinutes?: number;
    durationMinutes?: number;
    slotMinutes?: number;
  } = {}
): Date | null {
  const hours = options.hours ?? DEFAULT_BUSINESS_HOURS;
  const minLead = options.minLeadMinutes ?? 0;
  const duration = options.durationMinutes ?? 30;
  const slot = options.slotMinutes ?? 15;
  if (slot <= 0 || !Number.isInteger(slot)) {
    throw new TimeError('INVALID_SLOT', 'slotMinutes must be a positive whole number.');
  }
  const earliestMs = after.getTime() + minLead * 60_000;

  const start = zonedFields(new Date(earliestMs), hours.timeZone);
  for (let dayOffset = 0; dayOffset <= MAX_LOOKAHEAD_DAYS; dayOffset++) {
    // Step by calendar day in the ZONE, not by adding 86 400 000 ms: a DST day is 23 or 25
    // hours long, and fixed-millisecond stepping skips or repeats a date once a year. Noon is
    // the probe hour because no transition has ever moved the clock across it.
    const dayUtc = new Date(Date.UTC(start.year, start.month - 1, start.day + dayOffset, 12, 0, 0));
    const dayFields = zonedFields(dayUtc, hours.timeZone);
    if (hours.holidays.includes(localDateKey(dayFields))) continue;
    const window = hours.days[dayFields.weekday];
    if (window === null || window === undefined) continue;

    const latestStartMinute = window.closeMinute - duration;
    for (let minute = window.openMinute; minute <= latestStartMinute; minute += slot) {
      const resolved = civilToInstant(
        {
          year: dayFields.year,
          month: dayFields.month,
          day: dayFields.day,
          hour: Math.floor(minute / 60),
          minute: minute % 60,
          second: 0,
        },
        hours.timeZone
      );
      // A skipped hour yields no instant; an ambiguous one yields two and we take neither
      // implicitly — both are simply not offered as the next free slot.
      if (resolved.ok === false) continue;
      if (resolved.instant.getTime() >= earliestMs) return resolved.instant;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Meeting times: an instant plus the zone it was agreed in
// ---------------------------------------------------------------------------

/**
 * A meeting is stored as both, and the second is not decoration. "Tuesday at 2" is what the
 * customer agreed to; the instant is what the calendar needs. Keeping only the instant loses the
 * ability to say what was agreed, to re-render it after a tz-database update, or to tell a
 * customer in Dhaka what time their London meeting is in their own terms.
 */
export interface ScheduledTime {
  readonly startAtUtc: string; // ISO-8601, always with Z
  readonly timeZone: string; // IANA identifier
}

export function scheduledTime(instant: Date, zone: string): ScheduledTime {
  assertTimeZone(zone);
  if (Number.isNaN(instant.getTime())) throw new TimeError('INVALID_INSTANT', 'Invalid Date.');
  return Object.freeze({ startAtUtc: new Date(instant.getTime()).toISOString(), timeZone: zone });
}

export function scheduledInstant(value: ScheduledTime): Date {
  return parseInstant(value.startAtUtc);
}

/**
 * Render whatever the datastore handed back as an ISO instant, or null.
 *
 * Firestore returns a `Timestamp`, which carries `toMillis()` and `toDate()` but NOT
 * `toISOString()`. A route that called `toISOString()` on one got `undefined` and answered 200
 * with an empty field — which a runtime probe found and neither the compiler (the value is
 * `any` off the snapshot) nor the tests (which never round-tripped through the store) could.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const candidate = value as { toMillis?: () => number; toDate?: () => Date };
  if (typeof candidate.toMillis === 'function') {
    const ms = candidate.toMillis();
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  if (typeof candidate.toDate === 'function') {
    const asDate = candidate.toDate();
    return asDate instanceof Date && !Number.isNaN(asDate.getTime()) ? asDate.toISOString() : null;
  }
  if (typeof value === 'string') return tryParseInstant(value)?.toISOString() ?? null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** How the meeting reads to somebody in `viewerZone` — defaults to the zone it was agreed in. */
export function describeScheduledTime(value: ScheduledTime, viewerZone?: string): string {
  const zone = viewerZone ?? value.timeZone;
  assertTimeZone(zone);
  const instant = scheduledInstant(value);
  const rendered = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
  return `${rendered} (${zone})`;
}
