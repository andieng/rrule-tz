import { Options, RRule, RRuleSet, rrulestr } from 'rrule';
import { RRuleTZError } from './errors';
import { OccurrenceSize, OccurrencePosition } from './types';
import { getLocalTimeInUtc, getUtcTimeFromLocal, isValidTimezone, MACHINE_LOCAL_TZ } from './timezone';
import { shiftByWeekday } from './weekday';
import { shiftTimeOfDay, shiftByMonthday, shiftByYearday, shiftByWeekno } from './byshift';

/** Midnight UTC for `date`'s UTC-labeled calendar day, for whole-day diffing/shifting. */
function startOfDayUtc(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
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

  /** A true UTC instant -> floating digits in MACHINE_LOCAL_TZ, to match rrule's internal candidates before querying before()/after()/between(). */
  private hostFloatingFromUtc(trueUtc: Date): Date {
    return this.tzid ? getLocalTimeInUtc(MACHINE_LOCAL_TZ, trueUtc) : trueUtc;
  }

  /** Floating digits in MACHINE_LOCAL_TZ (raw rrule output) -> the true UTC instant. */
  private utcFromHostFloating(hostFloating: Date): Date {
    return this.tzid ? getUtcTimeFromLocal(MACHINE_LOCAL_TZ, hostFloating) : hostFloating;
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
    const { origOptions } = this.rrule;
    const isFinite = origOptions.count != null || origOptions.until != null;
    if (!isFinite) {
      throw new RRuleTZError('allUTC() cannot enumerate an infinite rule (no COUNT/UNTIL). Use betweenUTC() instead.');
    }

    return this.rruleSet.all().map(occurrence => this.utcFromHostFloating(occurrence));
  }

  firstExecutionUTC(): Date | null {
    const firstExecLocalTime = this.rruleSet.after(new Date(0), true);
    if (!firstExecLocalTime) return null;

    return this.utcFromHostFloating(firstExecLocalTime);
  }

  lastExecutionUTC(): Date | null {
    const { origOptions } = this.rrule;
    const isFinite = origOptions.count != null || origOptions.until != null;
    if (!isFinite) return null;

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
   * excludeDate/moveStartAfter/moveUntilBefore/convertToTimezone instead of being downgraded to
   * a plain RRuleTZ. Subclasses that validate in their constructor will therefore re-validate
   * each edit's result.
   */
  protected create(str: string): this {
    const Ctor = this.constructor as new (rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions) => this;
    return new Ctor(str);
  }

  /** Carries this set's EXRULE/EXDATE/RDATE lines over into a rebuilt set unchanged. */
  private copySetExtrasInto(newRRuleSet: RRuleSet): void {
    this.rruleSet.exrules().forEach(exrule => newRRuleSet.exrule(exrule));
    this.rruleSet.exdates().forEach(exdate => newRRuleSet.exdate(exdate));
    this.rruleSet.rdates().forEach(rdate => newRRuleSet.rdate(rdate));
  }

  moveUntilBefore(occurrence: Date): this {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    const previousOccurrenceUtc = this.prevOccurrence(occurrence);
    if (!previousOccurrenceUtc) {
      throw new RRuleTZError('No preceding occurrence found to use as the new UNTIL');
    }

    const ruleFloating = this.ruleFloatingFromUtc(previousOccurrenceUtc);
    const until = new Date(
      Date.UTC(ruleFloating.getUTCFullYear(), ruleFloating.getUTCMonth(), ruleFloating.getUTCDate(), 23, 59, 0, 0),
    );

    const newRRuleSet = new RRuleSet();
    newRRuleSet.rrule(new RRule({ ...this.rrule.origOptions, count: null, until }));
    this.copySetExtrasInto(newRRuleSet);

    return this.create(newRRuleSet.toString());
  }

  /**
   * Returns a new helper with DTSTART moved to the next occurrence after `occurrence` (which must
   * be this rule's current first occurrence), decrementing COUNT by one if count-based - shifting
   * DTSTART alone would otherwise yield one occurrence too many. Used instead of excludeDate for
   * the first occurrence, since there's nothing before it for an EXDATE to sit "between".
   */
  moveStartAfter(occurrence: Date): this {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    const nextOccurrenceUtc = this.nextOccurrence(occurrence);
    if (!nextOccurrenceUtc) {
      throw new RRuleTZError('No following occurrence found to use as the new DTSTART');
    }

    const { origOptions } = this.rrule;

    const newRRuleSet = new RRuleSet();
    newRRuleSet.rrule(
      new RRule({
        ...this.rrule.origOptions,
        dtstart: this.ruleFloatingFromUtc(nextOccurrenceUtc),
        count: origOptions.count != null ? origOptions.count - 1 : null,
      }),
    );
    this.copySetExtrasInto(newRRuleSet);

    return this.create(newRRuleSet.toString());
  }

  excludeDate(occurrence: Date): this {
    if (!this.hasOccurrence(occurrence)) {
      throw new RRuleTZError('The occurrence is not part of the recurrence rule');
    }

    const newRRuleSet = new RRuleSet();
    newRRuleSet.rrule(
      new RRule({
        ...this.rrule.origOptions,
      }),
    );
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

    if (first && last && first.getTime() === last.getTime()) {
      return OccurrenceSize.ONE;
    } else {
      return OccurrenceSize.MANY;
    }
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
   * EXDATE and RDATE are each converted to their true wall-clock digits in `newTzid`. Since that
   * conversion can push occurrences onto a different calendar day (e.g. 23:00 in Berlin is already
   * the next day in Saigon), the calendar-relative fields - BYDAY, UNTIL, BYMONTHDAY, BYYEARDAY,
   * BYWEEKNO - are shifted by that day-delta instead of being converted through a true UTC
   * instant, and BYHOUR/BYMINUTE are shifted by the offset delta itself. EXRULEs get the same
   * treatment. Throws RRuleTZError for the few value/shift combinations RRULE syntax genuinely
   * cannot express (e.g. BYHOUR values that a shift splits across midnight, or BYMONTHDAY=31
   * shifted into the next month) rather than producing a silently wrong rule.
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
      return {
        ...opts,
        tzid: newTzid,
        dtstart: newDtstart,
        until: opts.until ? new Date(opts.until.getTime() + time.dayShift * MS_PER_DAY) : null,
        byweekday: shiftByWeekday(opts.byweekday, time.dayShift),
        byhour: time.byhour,
        byminute: time.byminute,
        bymonthday: shiftByMonthday(opts.bymonthday, time.dayShift),
        byyearday: shiftByYearday(opts.byyearday, time.dayShift),
        byweekno: shiftByWeekno(opts.byweekno, opts.byweekday, time.dayShift),
      };
    };

    const newRRuleSet = new RRuleSet();
    newRRuleSet.rrule(new RRule(convertRuleOptions(origOptions)));
    this.rruleSet.exrules().forEach(exrule => newRRuleSet.exrule(new RRule(convertRuleOptions(exrule.origOptions))));
    this.rruleSet.exdates().forEach(exdate => newRRuleSet.exdate(toNewRuleFloating(exdate)));
    this.rruleSet.rdates().forEach(rdate => newRRuleSet.rdate(toNewRuleFloating(rdate)));

    return this.create(newRRuleSet.toString());
  }

  static init(rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions): RRuleTZ {
    return new RRuleTZ(rule, options);
  }
}
