import { describe, it, expect, afterEach, vi } from 'vitest';
import { rrulestr } from 'rrule';
import { RRuleTZ } from '../src/rruleTz';
import { RRuleTZError } from '../src/errors';

describe('RRuleTZ', () => {
  describe('init', () => {
    it('accepts an existing RRuleSet instance instead of a string', () => {
      const set = rrulestr('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1', { forceset: true });
      const rule = RRuleTZ.init(set);
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-02-11T08:00:00.000Z');
    });

    it('passes rrulestr options through (unfold joins an RFC 5545 folded RRULE line)', () => {
      const folded = 'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;\n COUNT=1';
      const rule = RRuleTZ.init(folded, { unfold: true });
      // If COUNT were lost, the rule would be infinite and allUTC() would throw.
      expect(rule.allUTC().map(date => date.toISOString())).toEqual(['2026-02-11T08:00:00.000Z']);
    });
  });

  describe('subclassing (the "build your own extension" path the README documents)', () => {
    /** Mirrors how an app layers device-specific rule logic on top - see README. */
    class AppRuleHelper extends RRuleTZ {
      /** Needs tzid + both floating round-trips, which must therefore be reachable from a subclass. */
      dtstartLocalHour(): number | null {
        const { dtstart } = this.rrule.origOptions;
        if (!dtstart) return null;
        return this.ruleFloatingFromUtc(this.utcFromRuleFloating(dtstart)).getUTCHours();
      }

      static init(str: string): AppRuleHelper {
        return new AppRuleHelper(str);
      }
    }

    it('preserves the subclass through every immutable edit', () => {
      const rule = AppRuleHelper.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');
      const occurrence = new Date('2026-02-12T08:00:00.000Z');

      expect(rule.excludeDate(occurrence)).toBeInstanceOf(AppRuleHelper);
      expect(rule.moveUntilBefore(occurrence)).toBeInstanceOf(AppRuleHelper);
      expect(rule.moveStartAfter(new Date('2026-02-11T08:00:00.000Z'))).toBeInstanceOf(AppRuleHelper);
      expect(rule.convertToTimezone('Asia/Saigon')).toBeInstanceOf(AppRuleHelper);

      // ...and the subclass's own methods still work on the edited result.
      expect(rule.excludeDate(occurrence).dtstartLocalHour()).toBe(9);
    });

    it('exposes tzid publicly', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1');
      expect(rule.tzid).toBe('Europe/Berlin');
      expect(RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=1').tzid).toBeNull();
    });

    it('lets a subclass reuse the protected tzid round-trip helpers and inherit every query method', () => {
      const rule = AppRuleHelper.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1');
      expect(rule.dtstartLocalHour()).toBe(9);
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-02-11T08:00:00.000Z');
    });
  });

  describe('betweenUTC', () => {
    const iso = (rrule: string, startAt: string, endAt: string): string[] =>
      RRuleTZ.init(rrule)
        .betweenUTC(new Date(startAt), new Date(endAt))
        .map(date => date.toISOString());

    it('returns the true UTC instant for a TZID rule, independent of the host timezone', () => {
      // 09:00 Berlin (CET +1) -> 08:00Z.
      const rrule = 'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1';
      expect(iso(rrule, '2026-02-10T00:00:00.000Z', '2026-02-12T00:00:00.000Z')).toEqual(['2026-02-11T08:00:00.000Z']);
    });

    it('includes a TZID occurrence when a narrow window brackets its true UTC instant', () => {
      const rrule = 'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1';
      expect(iso(rrule, '2026-02-11T07:30:00.000Z', '2026-02-11T08:30:00.000Z')).toEqual(['2026-02-11T08:00:00.000Z']);
    });

    it('passes a non-TZID (explicit UTC) rule through unchanged', () => {
      const rrule = 'DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=1';
      expect(iso(rrule, '2026-02-10T00:00:00.000Z', '2026-02-12T00:00:00.000Z')).toEqual(['2026-02-11T09:00:00.000Z']);
    });
  });

  describe('allUTC', () => {
    it('returns every occurrence as true UTC instants, independent of the host timezone', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=3');
      expect(rule.allUTC().map(date => date.toISOString())).toEqual([
        '2026-02-11T08:00:00.000Z',
        '2026-02-12T08:00:00.000Z',
        '2026-02-13T08:00:00.000Z',
      ]);
    });

    it('excludes a TZID EXDATE regardless of the host timezone', () => {
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=Europe/Berlin:20260212T090000',
      );
      expect(rule.allUTC().map(date => date.toISOString())).toEqual([
        '2026-02-11T08:00:00.000Z',
        '2026-02-13T08:00:00.000Z',
      ]);
    });

    it('throws for an infinite rule (no COUNT/UNTIL) instead of iterating forever', () => {
      const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY');
      expect(() => rule.allUTC()).toThrow(RRuleTZError);
    });
  });

  describe('firstExecutionUTC', () => {
    it('returns the true UTC instant for a TZID rule, independent of the host timezone', () => {
      // 09:00 Berlin (CET +1) -> 08:00Z.
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1');
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-02-11T08:00:00.000Z');
    });

    it('returns the true UTC instant for a non-TZID rule, independent of the host timezone', () => {
      // No TZID means rrule already yields a true UTC instant - nothing to rezone.
      const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=1');
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-02-11T09:00:00.000Z');
    });

    describe('across simulated system timezones', () => {
      const RealDateTimeFormat = Intl.DateTimeFormat;

      /**
       * Only intercepts the no-arg "what's my system tz" call (used by MACHINE_LOCAL_TZ and
       * rrule's own host-tz lookup) - any explicit-zone call (e.g. dayjs's tz plugin resolving
       * 'Europe/Berlin') falls through to the real constructor untouched.
       */
      const mockSystemTimeZone = (fakeTz: string): void => {
        Intl.DateTimeFormat = function (...args: unknown[]) {
          if (args.length === 0) {
            return { resolvedOptions: () => ({ timeZone: fakeTz }) };
          }
          return new (RealDateTimeFormat as new (...args: unknown[]) => Intl.DateTimeFormat)(...args);
        } as typeof Intl.DateTimeFormat;
      };

      afterEach(() => {
        Intl.DateTimeFormat = RealDateTimeFormat;
        vi.resetModules();
      });

      it.each(['UTC', 'Asia/Saigon', 'Europe/Berlin', 'America/New_York', 'Australia/Sydney'])(
        'returns the true UTC instant for a TZID rule when system tz is %s',
        async fakeTz => {
          expect.assertions(1);
          mockSystemTimeZone(fakeTz);
          vi.resetModules(); // MACHINE_LOCAL_TZ is a module-level const, must re-evaluate

          const { RRuleTZ: FreshRRuleTZ } = await import('../src/rruleTz');
          const rule = FreshRRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1');
          expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-02-11T08:00:00.000Z');
        },
      );
    });
  });

  describe('nextOccurrence / prevOccurrence inclusivity', () => {
    const rule = () => RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
    const middle = new Date('2026-02-12T09:00:00.000Z');

    it('excludes the reference date by default', () => {
      expect(rule().nextOccurrence(middle)?.toISOString()).toBe('2026-02-13T09:00:00.000Z');
      expect(rule().prevOccurrence(middle)?.toISOString()).toBe('2026-02-11T09:00:00.000Z');
    });

    it('includes the reference date when inc is true and it is itself an occurrence', () => {
      expect(rule().nextOccurrence(middle, true)?.toISOString()).toBe('2026-02-12T09:00:00.000Z');
      expect(rule().prevOccurrence(middle, true)?.toISOString()).toBe('2026-02-12T09:00:00.000Z');
    });

    it('still moves on when inc is true but the reference date is not an occurrence', () => {
      const between = new Date('2026-02-12T10:00:00.000Z');
      expect(rule().nextOccurrence(between, true)?.toISOString()).toBe('2026-02-13T09:00:00.000Z');
      expect(rule().prevOccurrence(between, true)?.toISOString()).toBe('2026-02-12T09:00:00.000Z');
    });
  });

  describe('lastExecutionUTC', () => {
    it('returns the true UTC instant for a TZID rule, independent of the host timezone', () => {
      // 09:00 Berlin (CET +1), COUNT=3 -> last occurrence 2026-02-13T09:00 Berlin -> 08:00Z.
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=3');
      expect(rule.lastExecutionUTC()?.toISOString()).toBe('2026-02-13T08:00:00.000Z');
    });

    it('returns the true UTC instant for a non-TZID rule, independent of the host timezone', () => {
      // No TZID means rrule already yields a true UTC instant - nothing to rezone.
      const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
      expect(rule.lastExecutionUTC()?.toISOString()).toBe('2026-02-13T09:00:00.000Z');
    });

    it('returns null for an infinite rule (no COUNT/UNTIL)', () => {
      const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY');
      expect(rule.lastExecutionUTC()).toBeNull();
    });
  });

  describe('moveUntilBefore', () => {
    it('sets UNTIL to just before the given occurrence, preserving other rule properties', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T020000Z\nRRULE:FREQ=DAILY;COUNT=10');
      const truncated = rule.moveUntilBefore(new Date('2026-01-05T02:00:00.000Z'));
      expect(truncated.rruleSet.toString()).toBe('DTSTART:20260101T020000Z\nRRULE:FREQ=DAILY;UNTIL=20260104T235900Z');
    });

    it('sets UNTIL to just before the given occurrence, preserving other rule properties - rrule has tzid', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Asia/Ho_Chi_Minh:20270101T090000\nRRULE:FREQ=DAILY;COUNT=10');
      const truncated = rule.moveUntilBefore(new Date('2027-01-05T02:00:00.000Z'));
      expect(truncated.rruleSet.toString()).toBe(
        'DTSTART;TZID=Asia/Ho_Chi_Minh:20270101T090000\nRRULE:FREQ=DAILY;UNTIL=20270104T235900',
      );
    });

    it('preserves existing EXDATE/RDATE lines untouched', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE:20260103T090000Z');
      const truncated = rule.moveUntilBefore(new Date('2026-01-05T09:00:00.000Z'));
      expect(truncated.rruleSet.toString()).toBe(
        'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260104T235900Z\nEXDATE:20260103T090000Z',
      );
    });

    it('preserves an existing EXRULE line', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
      const truncated = rule.moveUntilBefore(new Date('2026-01-05T09:00:00.000Z'));
      expect(truncated.rruleSet.toString()).toContain('EXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
    });

    it('leaves at least the first occurrence intact', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      const truncated = rule.moveUntilBefore(new Date('2026-01-02T09:00:00.000Z'));
      expect(truncated.firstExecutionUTC()?.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    });

    it('returns an RRuleTZ instance', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      const truncated = rule.moveUntilBefore(new Date('2026-01-05T09:00:00.000Z'));
      expect(truncated).toBeInstanceOf(RRuleTZ);
    });

    it('throws when occurrence is not part of the recurrence rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      expect(() => rule.moveUntilBefore(new Date('2026-01-05T10:00:00.000Z'))).toThrow(RRuleTZError);
    });
  });

  describe('moveStartAfter', () => {
    it('moves DTSTART to the next occurrence, dropping the given one, for an infinite rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY');
      const advanced = rule.moveStartAfter(new Date('2026-01-01T09:00:00.000Z'));
      expect(advanced.rruleSet.toString()).toBe('DTSTART:20260102T090000Z\nRRULE:FREQ=DAILY');
    });

    it('moves DTSTART to the next occurrence, dropping the given one, for an infinite rule (have TZID)', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Asia/Ho_Chi_Minh:20260101T090000\nRRULE:FREQ=DAILY');
      const advanced = rule.moveStartAfter(new Date('2026-01-01T02:00:00.000Z'));
      expect(advanced.rruleSet.toString()).toBe('DTSTART;TZID=Asia/Ho_Chi_Minh:20260102T090000\nRRULE:FREQ=DAILY');
    });

    it('decrements COUNT by one for a count-based rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
      const advanced = rule.moveStartAfter(new Date('2026-01-01T09:00:00.000Z'));
      expect(advanced.rruleSet.toString()).toBe('DTSTART:20260102T090000Z\nRRULE:FREQ=DAILY;COUNT=2');
    });

    it('preserves an existing EXRULE line', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
      const moved = rule.moveStartAfter(new Date('2026-01-01T09:00:00.000Z'));
      expect(moved.rruleSet.toString()).toContain('EXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
    });

    it('leaves UNTIL untouched (already absolute) for an until-based rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260105T090000Z');
      const advanced = rule.moveStartAfter(new Date('2026-01-01T09:00:00.000Z'));
      expect(advanced.rruleSet.toString()).toBe('DTSTART:20260102T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260105T090000Z');
    });

    it('throws when there is no occurrence left after the given one', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=1');
      expect(() => rule.moveStartAfter(new Date('2026-01-01T09:00:00.000Z'))).toThrow(RRuleTZError);
    });

    it('throws when occurrence is not part of the recurrence rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      expect(() => rule.moveStartAfter(new Date('2026-01-05T10:00:00.000Z'))).toThrow(RRuleTZError);
    });
  });

  describe('excludeDate', () => {
    it('adds an EXDATE for the given occurrence, preserving other rule properties', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      const excluded = rule.excludeDate(new Date('2026-01-03T09:00:00.000Z'));
      expect(excluded.rruleSet.toString()).toBe(
        'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE:20260103T090000Z',
      );
    });

    it('preserves an existing EXRULE line', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
      const excluded = rule.excludeDate(new Date('2026-01-02T09:00:00.000Z'));
      expect(excluded.rruleSet.toString()).toContain('EXRULE:FREQ=WEEKLY;BYDAY=SA,SU');
      expect(excluded.rruleSet.toString()).toContain('EXDATE:20260102T090000Z');
    });

    it('preserves an existing EXDATE line and appends the new one', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE:20260102T090000Z');
      const excluded = rule.excludeDate(new Date('2026-01-03T09:00:00.000Z'));
      // Reconstructing the helper round-trips through rrule's own parser, which merges
      // multiple EXDATE lines into one comma-separated line - an equivalent, canonical form.
      expect(excluded.rruleSet.toString()).toBe(
        'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE:20260102T090000Z,20260103T090000Z',
      );
    });

    it('carries the TZID prefix from DTSTART onto the EXDATE line', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260101T093000\nRRULE:FREQ=DAILY;COUNT=10');
      // 2026-01-03T09:30 Berlin (CET, UTC+1) == 2026-01-03T08:30Z
      const excluded = rule.excludeDate(new Date('2026-01-03T08:30:00.000Z'));
      expect(excluded.rruleSet.toString()).toBe(
        'DTSTART;TZID=Europe/Berlin:20260101T093000\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE;TZID=Europe/Berlin:20260103T093000',
      );
    });

    it('uses the rule-local calendar date, not the true UTC date, for an early-morning TZID rule', () => {
      // 03:00 Australia/Sydney (+11, AEDT in January) -> true UTC instant falls on the PREVIOUS calendar day.
      const rule = RRuleTZ.init('DTSTART;TZID=Australia/Sydney:20270101T030000\nRRULE:FREQ=DAILY;COUNT=5');
      // 2nd occurrence: 2027-01-02T03:00 Sydney == 2027-01-01T16:00Z
      const excluded = rule.excludeDate(new Date('2027-01-01T16:00:00.000Z'));
      expect(excluded.rruleSet.toString()).toBe(
        'DTSTART;TZID=Australia/Sydney:20270101T030000\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE;TZID=Australia/Sydney:20270102T030000',
      );
    });

    it('throws when occurrence is not part of this rule’s series', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      expect(() => rule.excludeDate(new Date('2026-01-03T00:00:00.000Z'))).toThrow(RRuleTZError);
    });
  });

  describe('toString', () => {
    it('serializes the whole set, matching rruleSet.toString()', () => {
      const str =
        'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=Europe/Berlin:20260212T090000';
      const rule = RRuleTZ.init(str);
      expect(rule.toString()).toBe(rule.rruleSet.toString());
      expect(rule.toString()).toContain('EXDATE;TZID=Europe/Berlin:20260212T090000');
      expect(`${rule}`).toBe(rule.rruleSet.toString());
    });
  });

  describe('rdatesUTC / exdatesUTC', () => {
    it('returns RDATE/EXDATE entries as true UTC instants for a TZID rule', () => {
      // 09:00 Berlin (CET +1) -> 08:00Z; raw rruleSet.rdates()/exdates() would return floating 09:00.
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5\nRDATE;TZID=Europe/Berlin:20260220T090000\nEXDATE;TZID=Europe/Berlin:20260212T090000',
      );
      expect(rule.rdatesUTC().map(date => date.toISOString())).toEqual(['2026-02-20T08:00:00.000Z']);
      expect(rule.exdatesUTC().map(date => date.toISOString())).toEqual(['2026-02-12T08:00:00.000Z']);
    });

    it('passes non-TZID (already UTC) entries through unchanged', () => {
      const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=5\nEXDATE:20260212T090000Z');
      expect(rule.exdatesUTC().map(date => date.toISOString())).toEqual(['2026-02-12T09:00:00.000Z']);
      expect(rule.rdatesUTC()).toEqual([]);
    });
  });

  describe('hasOccurrence', () => {
    it('returns true when given a Date that matches an exact occurrence', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      expect(rule.hasOccurrence(new Date('2026-01-05T09:00:00.000Z'))).toBe(true);
    });

    it('returns false when given a Date that does not match any occurrence', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=10');
      expect(rule.hasOccurrence(new Date('2026-01-05T10:00:00.000Z'))).toBe(false);
    });

    it('handles a given Date against a TZID rule via betweenUTC', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260101T090000\nRRULE:FREQ=DAILY;COUNT=10');
      // 2026-01-05T09:00 Berlin (CET, UTC+1) == 2026-01-05T08:00Z
      expect(rule.hasOccurrence(new Date('2026-01-05T08:00:00.000Z'))).toBe(true);
      expect(rule.hasOccurrence(new Date('2026-01-05T09:00:00.000Z'))).toBe(false);
    });
  });

  describe('occurrenceSize / occurrencePosition', () => {
    it('reports ONE for a single-occurrence rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=1');
      expect(rule.occurrenceSize()).toBe('ONE');
    });

    it('reports MANY for a multi-occurrence rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
      expect(rule.occurrenceSize()).toBe('MANY');
    });

    it('reports FIRST/MIDDLE/LAST for a finite rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
      expect(rule.occurrencePosition(new Date('2026-01-01T09:00:00.000Z'))).toBe('FIRST');
      expect(rule.occurrencePosition(new Date('2026-01-02T09:00:00.000Z'))).toBe('MIDDLE');
      expect(rule.occurrencePosition(new Date('2026-01-03T09:00:00.000Z'))).toBe('LAST');
    });

    it('throws when the occurrence is not part of the rule', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
      expect(() => rule.occurrencePosition(new Date('2026-01-05T09:00:00.000Z'))).toThrow(RRuleTZError);
    });
  });

  describe('convertToTimezone', () => {
    it('shifts DTSTART, BYDAY, UNTIL and EXDATE onto the next calendar day when converting Europe/Berlin to Asia/Saigon', () => {
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Europe/Berlin:20260101T230000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260110T235900\nEXDATE;TZID=Europe/Berlin:20260105T230000',
      );
      const newRule = rule.convertToTimezone('Asia/Saigon');
      expect(newRule.rruleSet.toString()).toBe(
        'DTSTART;TZID=Asia/Saigon:20260102T050000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;UNTIL=20260111T235900\nEXDATE;TZID=Asia/Saigon:20260106T050000',
      );
    });

    it('shifts DTSTART, BYDAY, UNTIL and EXDATE back a calendar day when converting Asia/Saigon to Europe/Berlin (inverse of the previous case)', () => {
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Asia/Saigon:20260102T050000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;UNTIL=20260111T235900\nEXDATE;TZID=Asia/Saigon:20260106T050000',
      );
      const newRule = rule.convertToTimezone('Europe/Berlin');
      expect(newRule.rruleSet.toString()).toBe(
        'DTSTART;TZID=Europe/Berlin:20260101T230000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260110T235900\nEXDATE;TZID=Europe/Berlin:20260105T230000',
      );
    });

    it('converts a non-TZID (true UTC) rule into a TZID rule in the target timezone', () => {
      const rule = RRuleTZ.init(
        'DTSTART:20260101T230000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260110T235900Z\nEXDATE:20260105T230000',
      );
      const newRule = rule.convertToTimezone('Asia/Saigon');
      expect(newRule.rruleSet.toString()).toBe(
        'DTSTART;TZID=Asia/Saigon:20260102T060000\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;UNTIL=20260111T235900\nEXDATE;TZID=Asia/Saigon:20260106T060000',
      );
    });

    it('throws when newTzid is not a recognized IANA timezone name', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260101T230000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
      expect(() => rule.convertToTimezone('Not/A_Real_Zone')).toThrow(RRuleTZError);
    });

    /** The gold check: the converted rule must produce the exact same true-UTC instants. */
    const expectSameOccurrences = (rruleString: string, newTzid: string, from: string, to: string): RRuleTZ => {
      const original = RRuleTZ.init(rruleString);
      const converted = original.convertToTimezone(newTzid);
      const occurrences = original.betweenUTC(new Date(from), new Date(to)).map(date => date.toISOString());
      expect(occurrences.length).toBeGreaterThan(0);
      expect(converted.betweenUTC(new Date(from), new Date(to)).map(date => date.toISOString())).toEqual(occurrences);
      return converted;
    };

    it('shifts BYHOUR by a whole-hour offset delta without a day rollover', () => {
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260105T090000\nRRULE:FREQ=DAILY;BYHOUR=9,14;COUNT=6',
        'Asia/Saigon',
        '2026-01-04T00:00:00Z',
        '2026-01-10T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYHOUR=15,20');
    });

    it('rolls BYHOUR across midnight uniformly, shifting BYDAY along with it', () => {
      // Mon 20:00/23:00 Berlin -> Tue 02:00/05:00 Saigon: both hours carry into the next day.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260105T200000\nRRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=20,23;COUNT=4',
        'Asia/Saigon',
        '2026-01-04T00:00:00Z',
        '2026-01-20T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYHOUR=2,5');
      expect(converted.rruleSet.toString()).toContain('BYDAY=TU');
    });

    it('shifts BYMINUTE for a fractional-hour offset delta (Berlin -> Kolkata, +4:30)', () => {
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260105T090000\nRRULE:FREQ=DAILY;BYMINUTE=0,15;COUNT=6',
        'Asia/Kolkata',
        '2026-01-04T00:00:00Z',
        '2026-01-10T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYMINUTE=30,45');
    });

    it('passes BYSECOND through unchanged (offset deltas are whole minutes)', () => {
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260105T090015\nRRULE:FREQ=DAILY;BYSECOND=15;COUNT=3',
        'Asia/Saigon',
        '2026-01-04T00:00:00Z',
        '2026-01-10T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYSECOND=15');
    });

    it('throws when the shift splits BYHOUR values across midnight (not expressible as one rule)', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260105T090000\nRRULE:FREQ=DAILY;BYHOUR=9,23');
      expect(() => rule.convertToTimezone('Asia/Saigon')).toThrow(RRuleTZError);
    });

    it('throws when the shift splits BYMINUTE values across an hour boundary', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260105T090000\nRRULE:FREQ=DAILY;BYMINUTE=0,45');
      expect(() => rule.convertToTimezone('Asia/Kolkata')).toThrow(RRuleTZError);
    });

    it('shifts a mid-month BYMONTHDAY by the day rollover', () => {
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260115T230000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYMONTHDAY=16');
    });

    it('wraps BYMONTHDAY=1 to -1 when shifting back a day (1st minus a day is the last of every month)', () => {
      // Window stays inside Berlin winter time - wall-clock conversion diverges across a DST change.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Asia/Saigon:20260201T050000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1;COUNT=2',
        'Europe/Berlin',
        '2026-01-01T00:00:00Z',
        '2026-03-15T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYMONTHDAY=-1');
    });

    it('wraps BYMONTHDAY=-1 to 1 when shifting forward a day', () => {
      // Window stays inside Berlin winter time - wall-clock conversion diverges across a DST change.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260131T230000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2026-03-15T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYMONTHDAY=1');
    });

    it.each([
      [
        'BYMONTHDAY=31 forward',
        'DTSTART;TZID=Europe/Berlin:20260131T230000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=31',
        'Asia/Saigon',
      ],
      [
        'BYMONTHDAY=28 forward',
        'DTSTART;TZID=Europe/Berlin:20260128T230000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=28',
        'Asia/Saigon',
      ],
      [
        'BYMONTHDAY=29 backward',
        'DTSTART;TZID=Asia/Saigon:20260129T050000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=29',
        'Europe/Berlin',
      ],
    ])('throws for %s, whose shifted position depends on the month length', (_label, rruleString, target) => {
      const rule = RRuleTZ.init(rruleString);
      expect(() => rule.convertToTimezone(target)).toThrow(RRuleTZError);
    });

    it('shifts BYYEARDAY by the day rollover, wrapping -1 to 1 across the year boundary', () => {
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260214T230000\nRRULE:FREQ=YEARLY;BYYEARDAY=45;COUNT=2',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2027-12-31T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYYEARDAY=46');

      const wrapped = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20261231T230000\nRRULE:FREQ=YEARLY;BYYEARDAY=-1;COUNT=2',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2028-01-05T00:00:00Z',
      );
      expect(wrapped.rruleSet.toString()).toContain('BYYEARDAY=1');
    });

    it('throws for BYYEARDAY=365 shifted forward, whose position depends on leap years', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20261231T230000\nRRULE:FREQ=YEARLY;BYYEARDAY=365');
      expect(() => rule.convertToTimezone('Asia/Saigon')).toThrow(RRuleTZError);
    });

    it('keeps BYWEEKNO when the shifted weekday stays inside the same ISO week', () => {
      // Wed 23:00 Berlin -> Thu 05:00 Saigon: still week 7.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260211T230000\nRRULE:FREQ=YEARLY;BYWEEKNO=7;BYDAY=WE;COUNT=2',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2027-12-31T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYWEEKNO=7');
      expect(converted.rruleSet.toString()).toContain('BYDAY=TH');
    });

    it('increments BYWEEKNO when the shift moves Sunday across the ISO week boundary', () => {
      // Sun 23:00 Berlin (week 7) -> Mon 05:00 Saigon (week 8).
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260215T230000\nRRULE:FREQ=YEARLY;BYWEEKNO=7;BYDAY=SU;COUNT=2',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2027-12-31T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYWEEKNO=8');
      expect(converted.rruleSet.toString()).toContain('BYDAY=MO');
    });

    it('decrements BYWEEKNO when the shift moves Monday back across the ISO week boundary', () => {
      // Mon 05:00 Saigon (week 8) -> Sun 23:00 Berlin (week 7) - inverse of the previous case.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Asia/Saigon:20260216T050000\nRRULE:FREQ=YEARLY;BYWEEKNO=8;BYDAY=MO;COUNT=2',
        'Europe/Berlin',
        '2026-01-01T00:00:00Z',
        '2027-12-31T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('BYWEEKNO=7');
      expect(converted.rruleSet.toString()).toContain('BYDAY=SU');
    });

    it('throws for BYWEEKNO without BYDAY when the conversion shifts the calendar day', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T230000\nRRULE:FREQ=YEARLY;BYWEEKNO=7');
      expect(() => rule.convertToTimezone('Asia/Saigon')).toThrow(RRuleTZError);
    });

    it('throws when the shift moves some BYDAY weekdays into a different ISO week than others', () => {
      const rule = RRuleTZ.init('DTSTART;TZID=Asia/Saigon:20260216T050000\nRRULE:FREQ=YEARLY;BYWEEKNO=8;BYDAY=MO,WE');
      expect(() => rule.convertToTimezone('Europe/Berlin')).toThrow(RRuleTZError);
    });

    it('converts an EXRULE with the same day shift as the main rule', () => {
      // Daily 23:00 Berlin skipping Berlin weekends -> daily 05:00 Saigon skipping SU/MO.
      const converted = expectSameOccurrences(
        'DTSTART;TZID=Europe/Berlin:20260105T230000\nRRULE:FREQ=DAILY;COUNT=14\nEXRULE:FREQ=WEEKLY;BYDAY=SA,SU',
        'Asia/Saigon',
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:00Z',
      );
      expect(converted.rruleSet.toString()).toContain('EXRULE:FREQ=WEEKLY;BYDAY=SU,MO');
    });

    it('returns the same instance without rebuilding the rule when newTzid matches the current TZID', () => {
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Europe/Berlin:20260101T230000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260110T235900\nEXDATE;TZID=Europe/Berlin:20260105T230000',
      );
      const newRule = rule.convertToTimezone('Europe/Berlin');
      expect(newRule).toBe(rule);
    });
  });
});
