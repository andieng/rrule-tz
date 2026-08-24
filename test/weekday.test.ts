import { describe, it, expect } from 'vitest';
import { ByWeekday } from '../src/rruleInterop';
import { weekdayNum, weekdayOrdinal, shiftByWeekday } from '../src/weekday';
import { RRuleTZError } from '../src/errors';

/**
 * rrule's own `Weekday.fromStr` is `new Weekday(ALL_WEEKDAYS.indexOf(str))`, so it silently returns
 * `{ weekday: -1 }` for an ordinal string like "1MO" rather than throwing. These cover the local
 * parser that replaces it.
 *
 * rrule's `WeekdayStr` type only admits plain codes, so the ordinal-string and garbage cases are
 * unreachable from typed code - the casts below mirror what an untyped JS caller can still pass in.
 */
const byday = (value: string): ByWeekday => value as unknown as ByWeekday;

describe('BYDAY parsing (review 2, findings 5 and 6)', () => {
  it('reads the weekday out of an ordinal string', () => {
    expect(weekdayNum('MO')).toBe(0);
    expect(weekdayNum(byday('1MO'))).toBe(0);
    expect(weekdayNum(byday('-1SU'))).toBe(6);
  });

  it('reads the ordinal, or null when there is none', () => {
    expect(weekdayOrdinal('MO')).toBeNull();
    expect(weekdayOrdinal(byday('1MO'))).toBe(1);
    expect(weekdayOrdinal(byday('-1SU'))).toBe(-1);
  });

  it('preserves the ordinal when shifting a string entry', () => {
    expect(String(shiftByWeekday(byday('1MO'), 1))).toBe('+1TU');
    expect(String(shiftByWeekday('MO', 1))).toBe('TU');
  });

  it('rejects an unparseable BYDAY value instead of silently yielding -1', () => {
    expect(() => weekdayNum(byday('XX'))).toThrow(RRuleTZError);
    expect(() => weekdayNum(byday('1XX'))).toThrow(RRuleTZError);
  });
});
