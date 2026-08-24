import { ByWeekday, Weekday } from 'rrule';

/** Shifts a BYDAY weekday (0=MO..6=SU) forward/backward by `days` (days could be positive or negative), wrapping within the week. */
export function shiftWeekdayNum(weekday: number, days: number): number {
  return (((weekday + days) % 7) + 7) % 7;
}

/** The plain weekday number (0=MO..6=SU) of any of rrule's ByWeekday shapes (number, "MO"/"1MO" string, Weekday). */
export function weekdayNum(wd: ByWeekday): number {
  if (typeof wd === 'number') return wd;
  return (typeof wd === 'string' ? Weekday.fromStr(wd) : wd).weekday;
}

/**
 * Shifts a rule's BYDAY option (origOptions.byweekday) by `days` calendar days, preserving any
 * ordinal (e.g. the "1" in "1MO"). Used when a timezone conversion moves DTSTART onto a different
 * calendar day, since BYDAY is calendar-day-relative rather than a real-time instant.
 */
export function shiftByWeekday(
  byweekday: ByWeekday | ByWeekday[] | null | undefined,
  days: number,
): ByWeekday | ByWeekday[] | null | undefined {
  if (byweekday == null || days === 0) return byweekday;

  const shiftOne = (wd: ByWeekday): ByWeekday => {
    if (typeof wd === 'number') return shiftWeekdayNum(wd, days);
    const ordinal = typeof wd === 'string' ? Weekday.fromStr(wd).n : wd.n;
    return new Weekday(shiftWeekdayNum(weekdayNum(wd), days), ordinal);
  };

  return Array.isArray(byweekday) ? byweekday.map(shiftOne) : shiftOne(byweekday);
}
