import { ByWeekday } from 'rrule';
import { RRuleTZError } from './errors';
import { weekdayNum } from './weekday';

type NumberSet = number | number[] | null | undefined;

/** Normalizes rrule's `number | number[]` option shape; null for absent/empty (both mean "not set"). */
function toArray(value: NumberSet): number[] | null {
  if (value == null) return null;
  const arr = Array.isArray(value) ? value : [value];
  return arr.length ? arr : null;
}

/**
 * Shifts BYHOUR/BYMINUTE by the timezone-offset delta, carrying minute overflow into hours and
 * hour overflow into a whole-day shift. A carry is only representable when it is the same for
 * every value in a set - e.g. BYHOUR=9,23 shifted +6h puts 23:00 on the next calendar day but
 * 09:00 on the same one, and no single RRULE can say "these hours, but on different days" - so a
 * split carry throws. BYSECOND never shifts (IANA offsets are whole minutes).
 *
 * When a component is absent, rrule derives it from DTSTART, which converts exactly - but a
 * present BYMINUTE must then carry the same way as DTSTART's own minutes, or the derived hour
 * would disagree with the shifted minutes.
 *
 * @returns The shifted sets (undefined = stays derived from DTSTART) and `dayShift`: the whole-day
 * shift the rule's occurrences experience, which the calendar-relative fields (BYDAY, UNTIL,
 * BYMONTHDAY, ...) must follow. Falls back to `dtstartDayShift` when BYHOUR is absent.
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
): NumberSet {
  const weeks = toArray(byweekno);
  if (!weeks || dayShift === 0) return byweekno;

  const weekdays = byweekday == null ? [] : Array.isArray(byweekday) ? byweekday : [byweekday];
  if (!weekdays.length) {
    throw new RRuleTZError(
      'Cannot convert timezone: BYWEEKNO without BYDAY selects all 7 days of the week, and its day-shifted image is not a whole ISO week.',
    );
  }

  // 0=MO..6=SU; crossing uses the pre-shift weekdays, since it's the original day that moves.
  const crossings = new Set(
    weekdays.map(weekday => {
      const num = weekdayNum(weekday);
      return dayShift === 1 ? (num === 6 ? 1 : 0) : num === 0 ? -1 : 0;
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
