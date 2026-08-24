import { ByWeekday, Options, RRule } from './rruleInterop';
import { RRuleTZError } from './errors';
import { weekdayNum, weekdayOrdinal } from './weekday';

/**
 * Rejects conversions where the rule's calendar position is *derived from DTSTART* but DTSTART and
 * the occurrences move by a different number of days.
 *
 * When BYDAY/BYMONTHDAY/BYYEARDAY are absent, rrule derives them from DTSTART (WEEKLY: its weekday;
 * MONTHLY/YEARLY: its day), so they follow DTSTART's own day shift - but the occurrences follow the
 * BYHOUR-derived carry, which can differ. Nothing explicit exists for assertShiftableAcrossDays to
 * reject, so this checks it separately.
 */
export function assertDerivedCalendarFieldsSafe(
  opts: Partial<Options>,
  dtstartDayShift: number,
  occurrenceDayShift: number,
): void {
  if (dtstartDayShift === occurrenceDayShift) return;

  const isSet = (value: unknown): boolean => value != null && !(Array.isArray(value) && value.length === 0);

  // Any of these anchors the rule explicitly, so nothing is derived from DTSTART.
  const anchored =
    isSet(opts.byweekday) ||
    isSet(opts.bymonthday) ||
    isSet(opts.byyearday) ||
    isSet(opts.byweekno) ||
    isSet(opts.byeaster);
  if (anchored) return;

  // DAILY and finer repeat every period regardless of calendar position - nothing is derived.
  const derivesFromDtstart = opts.freq === RRule.YEARLY || opts.freq === RRule.MONTHLY || opts.freq === RRule.WEEKLY;
  if (!derivesFromDtstart) return;

  throw new RRuleTZError(
    'Cannot convert timezone: this rule takes its calendar position from DTSTART, but the timezone shift moves DTSTART and the occurrences onto different days. Set BYDAY/BYMONTHDAY explicitly to convert it.',
  );
}

/**
 * Rejects rule options whose meaning a whole-day shift changes in a way no single RRULE can
 * express. Both select a day *by position within a computed set*, so shifting the underlying
 * weekdays re-anchors that position instead of translating it:
 * - Ordinal BYDAY ("1SU"): "the first Monday" isn't "the day after the first Sunday" - they can
 *   land weeks apart.
 * - BYSETPOS: "last weekday of the month" shifted becomes "last Tue-Sat", a different day near
 *   month boundaries.
 */
export function assertShiftableAcrossDays(opts: Partial<Options>, dayShift: number): void {
  if (dayShift === 0) return;

  const weekdays = opts.byweekday == null ? [] : Array.isArray(opts.byweekday) ? opts.byweekday : [opts.byweekday];
  const ordinal = weekdays.find(wd => weekdayOrdinal(wd) != null);
  if (ordinal != null) {
    throw new RRuleTZError(
      `Cannot convert timezone: BYDAY=${String(ordinal)} is position-based, and shifting it by ${dayShift} day(s) would select different dates rather than the same occurrences.`,
    );
  }

  const bysetpos = opts.bysetpos;
  const hasSetpos = Array.isArray(bysetpos) ? bysetpos.length > 0 : bysetpos != null;
  if (hasSetpos) {
    throw new RRuleTZError(
      `Cannot convert timezone: BYSETPOS selects by position within each period, so a ${dayShift}-day shift changes which occurrence it picks.`,
    );
  }

  // BYMONTH is a hard filter on the occurrence's own month, and unlike BYMONTHDAY/BYDAY it isn't
  // shifted here - there is no correct whole-month shift for a one-day move. Any occurrence sitting
  // on a month edge crosses out of the allowed month and is either dropped or, combined with a
  // wrapped BYMONTHDAY, re-selected in a completely different month (Jan 31 -> Dec 31 was measured).
  const bymonth = opts.bymonth;
  const hasMonth = Array.isArray(bymonth) ? bymonth.length > 0 : bymonth != null;
  if (hasMonth) {
    throw new RRuleTZError(
      `Cannot convert timezone: BYMONTH filters on the occurrence's month, so a ${dayShift}-day shift can move occurrences out of the selected month entirely.`,
    );
  }
}

type NumberSet = number | number[] | null | undefined;

/** Normalizes rrule's `number | number[]` option shape; null for absent/empty (both mean "not set"). */
function toArray(value: NumberSet): number[] | null {
  if (value == null) return null;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length ? arr : null;
}

/**
 * Shifts BYHOUR/BYMINUTE by the timezone-offset delta, carrying minute overflow into hours and
 * hour overflow into a whole-day shift. A carry must be the same for every value in the set - e.g.
 * BYHOUR=9,23 shifted +6h puts 23:00 on the next day but 09:00 on the same one, which no single
 * RRULE can express - so a split carry throws. BYSECOND never shifts (offsets are whole minutes).
 * A present BYMINUTE must carry the same way as DTSTART's own minutes, or the hour rrule derives
 * from DTSTART would disagree with the shifted minutes.
 *
 * @returns The shifted sets (undefined = stays derived from DTSTART) and `dayShift`: the whole-day
 * shift the calendar-relative fields (BYDAY, UNTIL, BYMONTHDAY, ...) must follow. Falls back to
 * `dtstartDayShift` when BYHOUR is absent.
 */
export function shiftTimeOfDay(
  byhour: NumberSet,
  byminute: NumberSet,
  dtstart: Date,
  deltaMinutes: number,
  dtstartDayShift: number,
): { byhour: number[] | undefined; byminute: number[] | undefined; dayShift: number } {
  const deltaHours = Math.floor(deltaMinutes / 60);
  const deltaMins = deltaMinutes - deltaHours * 60; // 0..59
  const hours = toArray(byhour);
  const minutes = toArray(byminute);
  const dtstartMinCarry = Math.floor((dtstart.getUTCMinutes() + deltaMins) / 60);

  let minCarry = dtstartMinCarry;
  let newByminute: number[] | undefined;
  if (minutes) {
    const shifted = minutes.map(minute => minute + deltaMins);
    const carries = new Set(shifted.map(total => Math.floor(total / 60)));
    if (carries.size > 1) {
      throw new RRuleTZError(
        `Cannot convert timezone: shifting BYMINUTE=${minutes.join(',')} by ${deltaMins} minutes splits the values across an hour boundary, which a single RRULE cannot express.`,
      );
    }
    minCarry = [...carries][0];
    if (!hours && minCarry !== dtstartMinCarry) {
      throw new RRuleTZError(
        `Cannot convert timezone: BYMINUTE=${minutes.join(',')} carries across the hour differently than DTSTART's own minutes, so the hour derived from DTSTART would be wrong.`,
      );
    }
    newByminute = shifted.map(total => ((total % 60) + 60) % 60);
  }

  let dayShift = dtstartDayShift;
  let newByhour: number[] | undefined;
  if (hours) {
    const shifted = hours.map(hour => hour + deltaHours + minCarry);
    const carries = new Set(shifted.map(total => Math.floor(total / 24)));
    if (carries.size > 1) {
      throw new RRuleTZError(
        `Cannot convert timezone: shifting BYHOUR=${hours.join(',')} by the timezone offset splits the values across midnight, which a single RRULE cannot express.`,
      );
    }
    dayShift = [...carries][0];
    newByhour = shifted.map(total => ((total % 24) + 24) % 24);
  }

  return { byhour: newByhour, byminute: newByminute, dayShift };
}

/**
 * Shifts BYMONTHDAY values by a whole-day shift (±1), wrapping across the month boundary where
 * that has a single stable meaning: 1 <-> -1 (the 1st and the last day exist in every month).
 * Values whose shifted meaning depends on the month's length (e.g. 31 + 1: "the day after the
 * 31st" only happens after 31-day months, which BYMONTHDAY=1 cannot say) throw instead.
 */
export function shiftByMonthday(bymonthday: NumberSet, dayShift: number): NumberSet {
  const days = toArray(bymonthday);
  if (!days || dayShift === 0) return bymonthday;

  return days.map(day => {
    if (dayShift === 1) {
      if (day >= 1 && day <= 27) return day + 1;
      if (day === -1) return 1;
      if (day >= -28 && day <= -2) return day + 1;
    } else {
      if (day >= 2 && day <= 28) return day - 1;
      if (day === 1) return -1;
      if (day >= -27 && day <= -1) return day - 1;
    }
    throw new RRuleTZError(
      `Cannot convert timezone: BYMONTHDAY=${day} shifted by ${dayShift} day(s) lands on a month boundary whose position depends on the month's length, which BYMONTHDAY cannot express.`,
    );
  });
}

/**
 * Shifts BYYEARDAY values by a whole-day shift (±1), wrapping 1 <-> -1 across the year boundary.
 * Values whose shifted meaning depends on leap years (365, 366 and their negative mirrors) throw.
 */
export function shiftByYearday(byyearday: NumberSet, dayShift: number): NumberSet {
  const days = toArray(byyearday);
  if (!days || dayShift === 0) return byyearday;

  return days.map(day => {
    if (dayShift === 1) {
      if (day >= 1 && day <= 364) return day + 1;
      if (day === -1) return 1;
      if (day >= -365 && day <= -2) return day + 1;
    } else {
      if (day >= 2 && day <= 365) return day - 1;
      if (day === 1) return -1;
      if (day >= -364 && day <= -1) return day - 1;
    }
    throw new RRuleTZError(
      `Cannot convert timezone: BYYEARDAY=${day} shifted by ${dayShift} day(s) has no fixed year-day - where it lands depends on whether the year is a leap year.`,
    );
  });
}

/**
 * Shifts BYWEEKNO for a whole-day shift. A day shift changes the ISO week number only when the
 * (pre-shift) weekday crosses the Monday boundary: +1 day crosses for SU, -1 day crosses for MO.
 * Every BYDAY weekday must cross the same way (else occurrences would land in different weeks),
 * and BYWEEKNO without BYDAY expands to all 7 days of the week, whose day-shifted image is not a
 * whole ISO week - both unrepresentable cases throw. Week numbers 52/53 and their negative
 * mirrors, whose meaning depends on the year's week count, also throw when they would move.
 */
export function shiftByWeekno(
  byweekno: NumberSet,
  byweekday: ByWeekday | ByWeekday[] | null | undefined,
  dayShift: number,
  wkst?: Options['wkst'],
): NumberSet {
  const weeks = toArray(byweekno);
  if (!weeks || dayShift === 0) return byweekno;

  const weekdays = byweekday == null ? [] : Array.isArray(byweekday) ? byweekday : [byweekday];
  if (!weekdays.length) {
    throw new RRuleTZError(
      'Cannot convert timezone: BYWEEKNO without BYDAY selects all 7 days of the week, and its day-shifted image is not a whole ISO week.',
    );
  }

  // The week boundary follows WKST (default Monday), not always Monday: rrule honours wkst when
  // expanding BYWEEKNO, so hardcoding MO would compute the wrong crossing under e.g. WKST=SU.
  const weekStart = wkst == null ? 0 : typeof wkst === 'number' ? wkst : weekdayNum(wkst);
  const lastDayOfWeek = (weekStart + 6) % 7;

  // Crossing uses the pre-shift weekdays, since it's the original day that moves.
  const crossings = new Set(
    weekdays.map(weekday => {
      const num = weekdayNum(weekday);
      return dayShift === 1 ? (num === lastDayOfWeek ? 1 : 0) : num === weekStart ? -1 : 0;
    }),
  );
  if (crossings.size > 1) {
    throw new RRuleTZError(
      'Cannot convert timezone: the day shift moves some BYDAY weekdays into a different ISO week than others, which a single BYWEEKNO cannot express.',
    );
  }

  const weekShift = [...crossings][0];
  if (weekShift === 0) return byweekno;

  return weeks.map(week => {
    if (weekShift === 1) {
      if (week >= 1 && week <= 51) return week + 1;
      if (week >= -52 && week <= -2) return week + 1;
    } else {
      if (week >= 2 && week <= 52) return week - 1;
      if (week >= -51 && week <= -1) return week - 1;
    }
    throw new RRuleTZError(
      `Cannot convert timezone: BYWEEKNO=${week} shifted by ${weekShift} week(s) crosses a year boundary or depends on whether the year has 53 ISO weeks.`,
    );
  });
}
