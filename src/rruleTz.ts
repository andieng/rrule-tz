import { Options, RRule, RRuleSet, rrulestr } from './rruleInterop';
import { RRuleTZError } from './errors';
import { OccurrenceSize, OccurrencePosition } from './types';
import { getLocalTimeInUtc, getUtcTimeFromLocal, isValidTimezone, machineLocalTz } from './timezone';
import { shiftByWeekday } from './weekday';
import {
  shiftTimeOfDay,
  shiftByMonthday,
  shiftByYearday,
  shiftByWeekno,
  assertShiftableAcrossDays,
  assertDerivedCalendarFieldsSafe,
} from './byshift';

/** Midnight UTC for `date`'s UTC-labeled calendar day, for whole-day diffing/shifting. */
function startOfDayUtc(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Whether an RRULE's own options give it a finite number of occurrences (COUNT or UNTIL). */
function isRuleBounded(opts: Partial<Options>): boolean {
  return opts.count != null || opts.until != null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** rrulestr's options, minus forceset - RRuleTZ always parses into a set. */
type RRuleTZParseOptions = Omit<NonNullable<Parameters<typeof rrulestr>[1]>, 'forceset'>;

export class RRuleTZ {
  private readonly _rruleSet: RRuleSet;

  constructor(rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions) {
    const str = typeof rule === 'string' ? rule : rule.toString();
    try {
      this._rruleSet = rrulestr(str, { ...options, forceset: true }) as RRuleSet;
    } catch {
      throw new RRuleTZError(`Invalid rrule string: ${str}`);
    }

    // A DTSTART+RDATE-only set parses fine and answers queries, but the `rrule` getter throws, which
    // takes out half the API (lastExecutionUTC, occurrenceSize, every edit method). Reject up front
    // rather than hand back an object that works for some calls and throws for others.
    if (this._rruleSet.rrules().length === 0) {
      throw new RRuleTZError('Unsupported rule: the set contains no RRULE. RRuleTZ wraps a recurrence rule.');
    }

    // Multiple RRULEs are supported - every query method iterates rruleSet directly. Only
    // moveStartAfter() rejects them, since DTSTART is shared by every RRULE (see its own doc).
  }

  get rruleSet(): RRuleSet {
    return this._rruleSet;
  }

  get rrule(): RRule {
    if (!this._rruleSet?.rrules()[0]) throw new RRuleTZError('No RRULE found in the set.');
    return this._rruleSet.rrules()[0];
  }

  /** The rule's own IANA timezone, or null for a floating/UTC rule. */
  get tzid(): string | null {
    return this.rruleSet.tzid() ?? null;
  }

  /**
   * rrule rezones a TZID rule's before()/after()/between() candidates using the host machine's
   * own system timezone (not this rule's real tzid) - these 3 helpers translate to/from that
   * space. All are no-ops for a non-TZID rule, which never gets rezoned in the first place.
   */

  /** A true UTC instant -> floating digits in the host zone, to match rrule's internal candidates before querying before()/after()/between(). */
  private hostFloatingFromUtc(trueUtc: Date): Date {
    return this.tzid ? getLocalTimeInUtc(machineLocalTz(), trueUtc) : trueUtc;
  }

  /** Floating digits in the host zone (raw rrule output) -> the true UTC instant. */
  private utcFromHostFloating(hostFloating: Date): Date {
    return this.tzid ? getUtcTimeFromLocal(machineLocalTz(), hostFloating) : hostFloating;
  }

  /**
   * A true UTC instant -> floating digits in this rule's own tzid, for building a new rrule string
   * field (DTSTART/EXDATE/RDATE). Protected so subclasses can build app-specific rule conversions
   * on top without re-deriving the tzid round-trip.
   */
  protected ruleFloatingFromUtc(trueUtc: Date): Date {
    return this.tzid ? getLocalTimeInUtc(this.tzid, trueUtc) : trueUtc;
  }

  /** Inverse of ruleFloatingFromUtc: floating digits in this rule's own tzid -> the true UTC instant. */
  protected utcFromRuleFloating(ruleFloating: Date): Date {
    return this.tzid ? getUtcTimeFromLocal(this.tzid, ruleFloating) : ruleFloating;
  }

  /**
   * Expands the rule over the inclusive [startAt, endAt] window and returns the occurrences as
   * true UTC instants, independent of the host machine's timezone.
   * @param startAt - Inclusive lower bound, a real UTC instant
   * @param endAt - Inclusive upper bound, a real UTC instant
   * @returns The occurrence instants in true UTC
   */
  betweenUTC(startAt: Date, endAt: Date): Date[] {
    return this.rruleSet
      .between(this.hostFloatingFromUtc(startAt), this.hostFloatingFromUtc(endAt), true)
      .map(occurrence => this.utcFromHostFloating(occurrence));
  }

  /**
   * Every occurrence of the rule, as true UTC instants. Throws for an infinite rule (no COUNT/UNTIL)
   * rather than iterating forever, same as rrule's own all() would effectively do.
   */
  allUTC(): Date[] {
    // Every RRULE in the set has to be bounded, not just one - a single unbounded rule makes the
    // whole set enumerate to rrule's MAXYEAR (millions of dates) regardless of what the others say.
    // An unbounded EXRULE is fine: it only removes candidates already generated within the RRULE's
    // own bounded window, so it never drives enumeration itself.
    const unbounded = this.rruleSet.rrules().some(rule => !isRuleBounded(rule.origOptions));
    if (unbounded) {
      throw new RRuleTZError(
        'allUTC() cannot enumerate an infinite rule (at least one RRULE has no COUNT/UNTIL). Use betweenUTC() instead.',
      );
    }

    return this.rruleSet.all().map(occurrence => this.utcFromHostFloating(occurrence));
  }

  firstExecutionUTC(): Date | null {
    // Anchored at the minimum representable date, not the epoch - a pre-1970 DTSTART would
    // otherwise report the first occurrence after 1970 as if it were the first overall, which also
    // made occurrencePosition() call the real first occurrence MIDDLE. Mirrors lastExecutionUTC().
    const firstExecLocalTime = this.rruleSet.after(new Date(-8640000000000000), true);
    if (!firstExecLocalTime) return null;

    return this.utcFromHostFloating(firstExecLocalTime);
  }

  lastExecutionUTC(): Date | null {
    // A last occurrence only exists if every RRULE eventually stops - one unbounded rule makes the
    // combined series run forever even if the others are finite.
    const allBounded = this.rruleSet.rrules().every(rule => isRuleBounded(rule.origOptions));
    if (!allBounded) return null;

    const lastExecLocalTime = this.rruleSet.before(new Date(8640000000000000), true);
    if (!lastExecLocalTime) return null;

    return this.utcFromHostFloating(lastExecLocalTime);
  }

  /**
   * The first occurrence after `referenceDate`, as a true UTC instant.
   * @param inc - When true, `referenceDate` itself counts as a match if it is an occurrence
   */
  nextOccurrence(referenceDate: Date, inc = false): Date | undefined {
    const searchFrom = this.hostFloatingFromUtc(referenceDate);
    const occurrence = this._rruleSet.after(searchFrom, inc);
    if (!occurrence) return undefined;

    return this.utcFromHostFloating(occurrence);
  }

  /**
   * The last occurrence before `referenceDate`, as a true UTC instant.
   * @param inc - When true, `referenceDate` itself counts as a match if it is an occurrence
   */
  prevOccurrence(referenceDate: Date, inc = false): Date | undefined {
    const searchFrom = this.hostFloatingFromUtc(referenceDate);
    const occurrence = this._rruleSet.before(searchFrom, inc);
    if (!occurrence) return undefined;

    return this.utcFromHostFloating(occurrence);
  }

  /** The rule serialized back to its iCalendar string (DTSTART + RRULE + any EXRULE/EXDATE/RDATE). */
  toString(): string {
    return this.rruleSet.toString();
  }

  /**
   * Builds the result of an edit using the receiver's own constructor, so a subclass survives
   * edits instead of being downgraded to a plain RRuleTZ. Re-validates if the subclass does.
   */
  protected create(str: string): this {
    const Ctor = this.constructor as new (rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions) => this;
    return new Ctor(str);
  }

  /**
   * Carries this set's EXRULE/EXDATE/RDATE lines over into a rebuilt set.
   * @param keepRdate - RDATEs are standalone dates that UNTIL/COUNT do not bound, so a caller that
   * narrows the series has to drop the ones now outside it explicitly.
   */
  private copySetExtrasInto(newRRuleSet: RRuleSet, keepRdate: (rdate: Date) => boolean = () => true): void {
    this.rruleSet.exrules().forEach(exrule => newRRuleSet.exrule(exrule));
    this.rruleSet.exdates().forEach(exdate => newRRuleSet.exdate(exdate));
    this.rruleSet
      .rdates()
      .filter(keepRdate)
      .forEach(rdate => newRRuleSet.rdate(rdate));
  }

  /**
   * The next instance of the bare RRULE strictly after `afterUtc`, ignoring RDATEs - an RDATE is a
   * one-off date that need not sit on the rule's cadence, and using it as DTSTART would re-phase
   * the whole series.
   */
  private nextBareInstance(afterUtc: Date): Date | undefined {
    const bareSet = new RRuleSet();
    bareSet.rrule(new RRule({ ...this.rrule.origOptions }));
    return new RRuleTZ(bareSet.toString()).nextOccurrence(afterUtc);
  }

  /**
   * `opts` unchanged if it already ends at or before `cutoffUtc`; otherwise `opts` with COUNT
   * cleared and UNTIL set to `cutoffFloating`. Giving every RRULE the same UNTIL unconditionally
   * would extend one that was already meant to stop earlier.
   */
  private truncateRuleAt(opts: Partial<Options>, cutoffUtc: Date, cutoffFloating: Date): Partial<Options> {
    if (isRuleBounded(opts)) {
      const bareSet = new RRuleSet();
      bareSet.rrule(new RRule({ ...opts }));
      const naturalEnd = new RRuleTZ(bareSet.toString()).lastExecutionUTC();
      if (naturalEnd && naturalEnd.getTime() <= cutoffUtc.getTime()) return opts;
    }

    return { ...opts, count: null, until: cutoffFloating };
  }

  moveUntilBefore(occurrence: Date): this {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    const previousOccurrenceUtc = this.prevOccurrence(occurrence);
    if (!previousOccurrenceUtc) {
      throw new RRuleTZError('No preceding occurrence found to use as the new UNTIL');
    }

    // UNTIL is inclusive in RFC 5545, so the previous occurrence's own timestamp keeps it and drops
    // `occurrence`. Rounding up to 23:59 of its calendar day instead would re-admit every later
    // occurrence on that same day - which silently *extends* any sub-daily rule (FREQ=HOURLY, or
    // BYHOUR with several hours) rather than truncating it.
    const until = this.ruleFloatingFromUtc(previousOccurrenceUtc);

    const newRRuleSet = new RRuleSet();
    // Each RRULE is truncated independently, not given the same UNTIL uniformly: a rule that
    // already ends at or before the cutoff (e.g. a second RRULE with its own earlier COUNT) must be
    // left as-is - overwriting its COUNT with this cutoff would *extend* it instead of truncating.
    this.rruleSet
      .rrules()
      .forEach(rule =>
        newRRuleSet.rrule(new RRule(this.truncateRuleAt(rule.origOptions, previousOccurrenceUtc, until))),
      );
    // UNTIL doesn't bound RDATEs, so carrying them all over would leave `occurrence` in the series
    // when it was itself an RDATE - a silent no-op for the caller.
    this.copySetExtrasInto(newRRuleSet, rdate => rdate.getTime() <= until.getTime());

    return this.create(newRRuleSet.toString());
  }

  /**
   * Returns a new helper with DTSTART moved to the next occurrence after `occurrence` (which must
   * be this rule's current first occurrence), decrementing COUNT by one if count-based - shifting
   * DTSTART alone would otherwise yield one occurrence too many. Used instead of excludeDate for
   * the first occurrence, since there's nothing before it for an EXDATE to sit "between".
   *
   * Unsupported for a multi-RRULE set: DTSTART is one line shared by every RRULE, so moving it can
   * silently change another rule's derived calendar position. Use excludeDate() instead.
   */
  moveStartAfter(occurrence: Date): this {
    if (this.rruleSet.rrules().length > 1) {
      throw new RRuleTZError(
        'moveStartAfter() does not support a set with multiple RRULEs, since DTSTART is shared by all of them. Use excludeDate() instead.',
      );
    }

    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    // Documented precondition, previously unchecked: passing a middle occurrence used to silently
    // delete every occurrence before it as well, and extend the tail to keep COUNT.
    const first = this.firstExecutionUTC();
    if (!first || first.getTime() !== occurrence.getTime()) {
      throw new RRuleTZError(
        "moveStartAfter() only accepts the rule's current first occurrence; use excludeDate() to drop a later one",
      );
    }

    const nextOccurrenceUtc = this.nextBareInstance(occurrence);
    if (!nextOccurrenceUtc) {
      throw new RRuleTZError('No following occurrence found to use as the new DTSTART');
    }

    const newRRuleSet = new RRuleSet();
    newRRuleSet.rrule(
      new RRule({
        ...this.rrule.origOptions,
        dtstart: this.ruleFloatingFromUtc(nextOccurrenceUtc),
        count: this.countFromNewStart(nextOccurrenceUtc),
      }),
    );
    // The dropped occurrence must not survive as an RDATE.
    this.copySetExtrasInto(newRRuleSet, rdate => rdate.getTime() >= this.ruleFloatingFromUtc(occurrence).getTime() + 1);

    return this.create(newRRuleSet.toString());
  }

  /**
   * The COUNT a rule restarted at `newStart` needs to cover exactly the remaining instances. A
   * plain `count - 1` is only right when the new DTSTART is the very next instance; an EXDATE in
   * the gap can skip several at once. Returns null for a rule with no COUNT.
   */
  private countFromNewStart(newStart: Date): number | null {
    const { origOptions } = this.rrule;
    if (origOptions.count == null) return null;

    // Count against the bare RRULE - EXDATEs remove occurrences from the output but still consume
    // COUNT slots, so they must not be subtracted here.
    const bareSet = new RRuleSet();
    bareSet.rrule(new RRule({ ...origOptions }));
    const bareInstances = new RRuleTZ(bareSet.toString()).allUTC();

    return bareInstances.filter(instance => instance.getTime() >= newStart.getTime()).length;
  }

  excludeDate(occurrence: Date): this {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    const newRRuleSet = new RRuleSet();
    // EXDATE bounds the whole set's combined output, not any one RRULE, so every rule is carried
    // over unchanged - which RRULE would have produced `occurrence` doesn't matter here.
    this.rruleSet.rrules().forEach(rule => newRRuleSet.rrule(new RRule({ ...rule.origOptions })));
    this.copySetExtrasInto(newRRuleSet);
    newRRuleSet.exdate(this.ruleFloatingFromUtc(occurrence));

    return this.create(newRRuleSet.toString());
  }

  hasOccurrence(occurrence: Date): boolean {
    return this.betweenUTC(occurrence, occurrence).length > 0;
  }

  /** The set's RDATE entries as true UTC instants (rruleSet.rdates() returns floating digits for a TZID rule). */
  rdatesUTC(): Date[] {
    return this.rruleSet.rdates().map(rdate => this.utcFromRuleFloating(rdate));
  }

  /** The set's EXDATE entries as true UTC instants (rruleSet.exdates() returns floating digits for a TZID rule). */
  exdatesUTC(): Date[] {
    return this.rruleSet.exdates().map(exdate => this.utcFromRuleFloating(exdate));
  }

  occurrenceSize(): OccurrenceSize {
    const first = this.firstExecutionUTC();
    const last = this.lastExecutionUTC();

    // An empty rule has no first occurrence at all - reporting MANY there told callers the exact
    // opposite of the truth.
    if (!first) return OccurrenceSize.NONE;
    if (last && first.getTime() === last.getTime()) return OccurrenceSize.ONE;
    return OccurrenceSize.MANY;
  }

  occurrencePosition(occurrence: Date): OccurrencePosition {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }
    const first = this.firstExecutionUTC();
    const last = this.lastExecutionUTC();
    const occurrenceTime = occurrence.getTime();

    if (first && occurrenceTime === first.getTime()) return OccurrencePosition.FIRST;
    if (last && occurrenceTime === last.getTime()) return OccurrencePosition.LAST;
    return OccurrencePosition.MIDDLE;
  }

  /**
   * Returns a new helper for the same real-world occurrences re-expressed in `newTzid`. DTSTART,
   * EXDATE and RDATE convert to their true wall-clock digits in `newTzid`; since that can push
   * occurrences onto a different calendar day, the calendar-relative fields (BYDAY, UNTIL,
   * BYMONTHDAY, BYYEARDAY, BYWEEKNO) shift by that day-delta rather than through a UTC instant, and
   * BYHOUR/BYMINUTE shift by the offset delta itself. RRULEs and EXRULEs get the same treatment.
   * Throws RRuleTZError for value/shift combinations RRULE syntax genuinely cannot express (e.g.
   * BYHOUR split across midnight) rather than producing a silently wrong rule.
   * @param newTzid - IANA timezone name to convert the rule into (e.g. "Europe/Berlin")
   */
  convertToTimezone(newTzid: string): this {
    if (!isValidTimezone(newTzid)) {
      throw new RRuleTZError(`"${newTzid}" is not a valid IANA timezone name.`);
    }

    if (newTzid === this.tzid) {
      return this;
    }

    const { origOptions } = this.rrule;
    if (!origOptions.dtstart) throw new RRuleTZError('No DTSTART found in the rule.');
    const dtstart = origOptions.dtstart;

    const toNewRuleFloating = (ruleFloating: Date): Date =>
      getLocalTimeInUtc(newTzid, this.utcFromRuleFloating(ruleFloating));

    const newDtstart = toNewRuleFloating(dtstart);

    // The offset difference between the two zones at the DTSTART instant - exactly how far every
    // wall-clock time in the rule moves. IANA offsets are whole minutes (pre-1900 LMT aside).
    const deltaMs = newDtstart.getTime() - dtstart.getTime();
    if (deltaMs % 60000 !== 0) {
      throw new RRuleTZError(`The offset between the two timezones at DTSTART is not a whole number of minutes.`);
    }
    const deltaMinutes = deltaMs / 60000;
    const dtstartDayShift = (startOfDayUtc(newDtstart) - startOfDayUtc(dtstart)) / MS_PER_DAY;

    // Shared by the main rule and each EXRULE (they inherit the set's DTSTART, so the same delta
    // applies), but each rule shifts by its own BYHOUR-derived day carry.
    const convertRuleOptions = (opts: Partial<Options>): Partial<Options> => {
      const time = shiftTimeOfDay(opts.byhour, opts.byminute, dtstart, deltaMinutes, dtstartDayShift);
      // Must run against time.dayShift, not dtstartDayShift: when BYHOUR is present it is the
      // occurrences' own midnight carry that moves the calendar fields, and the two disagree
      // whenever DTSTART's clock time and BYHOUR fall on opposite sides of midnight. Asserting on
      // DTSTART's shift both let unsafe conversions through and rejected safe ones.
      assertShiftableAcrossDays(opts, time.dayShift);
      assertDerivedCalendarFieldsSafe(opts, dtstartDayShift, time.dayShift);
      return {
        ...opts,
        tzid: newTzid,
        dtstart: newDtstart,
        // UNTIL is a full timestamp, so it moves by the whole offset delta - not just the whole-day
        // part. Shifting it by days alone leaves a mid-day UNTIL too early in the new zone and
        // silently drops the final occurrence.
        until: opts.until ? new Date(opts.until.getTime() + deltaMinutes * 60000) : null,
        byweekday: shiftByWeekday(opts.byweekday, time.dayShift),
        byhour: time.byhour,
        byminute: time.byminute,
        bymonthday: shiftByMonthday(opts.bymonthday, time.dayShift),
        byyearday: shiftByYearday(opts.byyearday, time.dayShift),
        byweekno: shiftByWeekno(opts.byweekno, opts.byweekday, time.dayShift, opts.wkst),
      };
    };

    const newRRuleSet = new RRuleSet();
    // Every RRULE shares this set's single DTSTART, so the same delta/guards apply to each one -
    // the same treatment already given to EXRULEs below.
    this.rruleSet.rrules().forEach(rule => newRRuleSet.rrule(new RRule(convertRuleOptions(rule.origOptions))));
    this.rruleSet.exrules().forEach(exrule => newRRuleSet.exrule(new RRule(convertRuleOptions(exrule.origOptions))));
    this.rruleSet.exdates().forEach(exdate => newRRuleSet.exdate(toNewRuleFloating(exdate)));
    this.rruleSet.rdates().forEach(rdate => newRRuleSet.rdate(toNewRuleFloating(rdate)));

    return this.create(newRRuleSet.toString());
  }

  static init(rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions): RRuleTZ {
    return new RRuleTZ(rule, options);
  }
}
