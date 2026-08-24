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

    it("preserves rrulestr's specific parse error instead of a generic message (code review finding)", () => {
      try {
        RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;BOGUSPARAM=5');
        expect.unreachable('expected RRuleTZ.init to throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RRuleTZError);
        expect((e as RRuleTZError).message).toContain('Reason:');
        expect((e as RRuleTZError).message.toLowerCase()).toContain('bogusparam');
      }
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

  // Each case below reproduces a bug found in review; all of them passed silently before the fix.
  describe('regressions', () => {
    const iso = (d: Date): string => d.toISOString();

    it('is unaffected by a DST transition in the HOST timezone (finding 1)', () => {
      // 2026-03-08 is the US spring-forward. A New York host used to shift this Berlin rule by an
      // hour; Berlin's own DST doesn't start until 2026-03-29.
      const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260301T090000\nRRULE:FREQ=DAILY;COUNT=40');
      const byDay = new Map(rule.allUTC().map(d => [iso(d).slice(0, 10), iso(d)]));
      expect(byDay.get('2026-03-08')).toBe('2026-03-08T08:00:00.000Z');
      // ...and after Berlin's own transition the offset legitimately changes.
      expect(byDay.get('2026-04-04')).toBe('2026-04-04T07:00:00.000Z');
    });

    it('resolves EXDATE across a DST transition in the rule timezone (finding 1)', () => {
      const rule = RRuleTZ.init(
        'DTSTART;TZID=Australia/Sydney:20260401T003000\nRRULE:FREQ=DAILY;COUNT=10\nEXDATE;TZID=Australia/Sydney:20260405T003000',
      );
      expect(rule.exdatesUTC().map(iso)).toEqual(['2026-04-04T13:30:00.000Z']);
    });

    it('supports a set with multiple RRULEs instead of silently dropping all but the first (finding 5)', () => {
      const rule = RRuleTZ.init(
        'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2\nRRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=2',
      );
      expect(rule.allUTC().map(iso)).toEqual([
        '2026-01-01T09:00:00.000Z',
        '2026-01-02T09:00:00.000Z',
        '2026-01-04T09:00:00.000Z',
        '2026-01-11T09:00:00.000Z',
      ]);
    });

    it('follows the host zone when TZ changes after import (review 3, finding 1)', () => {
      // The host zone used to be cached at module load, while rrule's own rezoning reads it live -
      // so setting TZ after import (a routine test-setup pattern) desynced the two.
      const realTz = process.env.TZ;
      try {
        process.env.TZ = 'Pacific/Chatham'; // +12:45, deliberately not a whole-hour offset
        const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20240101T230000\nRRULE:FREQ=DAILY;COUNT=3');
        expect(rule.allUTC().map(iso)).toEqual([
          '2024-01-01T22:00:00.000Z',
          '2024-01-02T22:00:00.000Z',
          '2024-01-03T22:00:00.000Z',
        ]);
      } finally {
        if (realTz === undefined) delete process.env.TZ;
        else process.env.TZ = realTz;
      }
    });

    it('reports NONE for a rule with no occurrences (review 4, finding 5)', () => {
      // UNTIL precedes DTSTART. This used to report MANY - the opposite of the truth.
      const empty = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260210T000000Z');
      expect(empty.allUTC()).toHaveLength(0);
      expect(empty.occurrenceSize()).toBe('NONE');
    });

    it('rejects a set with no RRULE rather than half-working (review 2, finding 4)', () => {
      // Used to construct fine, answer betweenUTC, then throw from the `rrule` getter on
      // occurrenceSize/lastExecutionUTC.
      expect(() => RRuleTZ.init('DTSTART:20260105T100000Z\nRDATE:20260106T100000Z')).toThrow(RRuleTZError);
    });

    it('reports the true first occurrence for a pre-1970 rule (finding 9)', () => {
      const rule = RRuleTZ.init('DTSTART:19600101T090000Z\nRRULE:FREQ=YEARLY;COUNT=20');
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('1960-01-01T09:00:00.000Z');
      expect(rule.occurrencePosition(new Date('1960-01-01T09:00:00.000Z'))).toBe('FIRST');
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

    it('allows an unbounded EXRULE, since only an RRULE can make enumeration run away (finding 8)', () => {
      // allUTC() checks every RRULE in the set for boundedness (see the multi-RRULE describe block
      // below), but never EXRULEs - they only ever subtract from what the bounded RRULE(s) already
      // generated, so an unbounded one terminates fine.
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2\nEXRULE:FREQ=DAILY');
      expect(() => rule.allUTC()).not.toThrow();
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
       * Only intercepts the no-arg "what is my system tz" call (used by machineLocalTz() and
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
          vi.resetModules();

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

  // A set can legitimately have more than one RRULE (e.g. "every Monday" + "the 1st of every
  // month"). Every query method handles this correctly via rruleSet's own combined iteration.
  describe('multi-RRULE sets', () => {
    const iso = (d: Date): string => d.toISOString();
    const twoRules = 'DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2\nRRULE:FREQ=WEEKLY;BYDAY=SU;COUNT=2';

    it('combines occurrences from every RRULE via betweenUTC/allUTC/hasOccurrence', () => {
      const rule = RRuleTZ.init(twoRules);
      const expected = [
        '2026-01-01T09:00:00.000Z',
        '2026-01-02T09:00:00.000Z',
        '2026-01-04T09:00:00.000Z',
        '2026-01-11T09:00:00.000Z',
      ];
      expect(rule.allUTC().map(iso)).toEqual(expected);
      expect(rule.betweenUTC(new Date('2026-01-01T00:00:00Z'), new Date('2026-01-31T00:00:00Z')).map(iso)).toEqual(
        expected,
      );
      expect(rule.hasOccurrence(new Date('2026-01-04T09:00:00.000Z'))).toBe(true);
      expect(rule.occurrenceSize()).toBe('MANY');
      expect(rule.occurrencePosition(new Date('2026-01-01T09:00:00.000Z'))).toBe('FIRST');
      expect(rule.occurrencePosition(new Date('2026-01-11T09:00:00.000Z'))).toBe('LAST');
    });

    it('throws from allUTC when any single RRULE is unbounded, even if another is finite', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2\nRRULE:FREQ=WEEKLY;BYDAY=SU');
      expect(() => rule.allUTC()).toThrow(RRuleTZError);
    });

    it('returns null from lastExecutionUTC when any single RRULE is unbounded', () => {
      const rule = RRuleTZ.init('DTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;COUNT=2\nRRULE:FREQ=WEEKLY;BYDAY=SU');
      expect(rule.lastExecutionUTC()).toBeNull();
      // firstExecutionUTC is unaffected - it only needs a lower bound, not a finite series.
      expect(rule.firstExecutionUTC()?.toISOString()).toBe('2026-01-01T09:00:00.000Z');
    });
  });
});
