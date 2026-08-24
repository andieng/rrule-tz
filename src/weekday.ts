import { ByWeekday, Weekday } from './rruleInterop';
import { RRuleTZError } from './errors';

const BYDAY_PATTERN = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/i;

/**
 * Normalizes any of rrule's BYDAY shapes to `{ weekday: 0=MO..6=SU, n: ordinal | null }`.
 *
 * Parses strings itself rather than via rrule's `Weekday.fromStr`, which silently returns
 * `{ weekday: -1 }` for an ordinal like "1MO" instead of throwing.
 */
function parseWeekday(wd: ByWeekday): { weekday: number; n: number | null } {
  if (typeof wd === 'number') return { weekday: wd, n: null };

  if (typeof wd === 'string') {
    const match = BYDAY_PATTERN.exec(wd.trim());
    if (!match) throw new RRuleTZError(`Unrecognized BYDAY value: "${wd}"`);
    return {
      weekday: Weekday.fromStr(match[2].toUpperCase() as Parameters<typeof Weekday.fromStr>[0]).weekday,
      n: match[1] ? Number(match[1]) : null,
    };
  }

  return { weekday: wd.weekday, n: wd.n ?? null };
}

/** Shifts a BYDAY weekday (0=MO..6=SU) forward/backward by `days` (days could be positive or negative), wrapping within the week. */
export function shiftWeekdayNum(weekday: number, days: number): number {
  return (((weekday + days) % 7) + 7) % 7;
}

/** The plain weekday number (0=MO..6=SU) of any of rrule's ByWeekday shapes (number, "MO"/"1MO" string, Weekday). */
export function weekdayNum(wd: ByWeekday): number {
  return parseWeekday(wd).weekday;
}

/** The ordinal on a BYDAY entry ("1SU" -> 1, "-1SU" -> -1), or null for a plain weekday. */
export function weekdayOrdinal(wd: ByWeekday): number | null {
  return parseWeekday(wd).n;
}

/**
 * Shifts a rule's BYDAY option by `days` calendar days, preserving any ordinal. Used when a
 * timezone conversion moves DTSTART onto a different calendar day. Shifting an ordinal entry isn't
 * generally meaning-preserving - callers should reject those first (see assertShiftableAcrossDays).
 */
export function shiftByWeekday(
  byweekday: ByWeekday | ByWeekday[] | null | undefined,
  days: number,
): ByWeekday | ByWeekday[] | null | undefined {
  if (byweekday == null || days === 0) return byweekday;

  const shiftOne = (wd: ByWeekday): ByWeekday => {
    const { weekday, n } = parseWeekday(wd);
    if (typeof wd === 'number') return shiftWeekdayNum(weekday, days);
    return new Weekday(shiftWeekdayNum(weekday, days), n ?? undefined);
  };

  return Array.isArray(byweekday) ? byweekday.map(shiftOne) : shiftOne(byweekday);
}
