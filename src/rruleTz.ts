import { Options, RRule, RRuleSet, rrulestr } from './rruleInterop';
import { RRuleTZError } from './errors';
import { OccurrenceSize, OccurrencePosition } from './types';
import { getLocalTimeInUtc, getUtcTimeFromLocal, machineLocalTz } from './timezone';

/** Whether an RRULE's own options give it a finite number of occurrences (COUNT or UNTIL). */
function isRuleBounded(opts: Partial<Options>): boolean {
  return opts.count != null || opts.until != null;
}

/** JS's actual Date range boundaries, used as unbounded search anchors for first/lastExecutionUTC. */
const MIN_DATE = new Date(-8640000000000000);
const MAX_DATE = new Date(8640000000000000);

/** rrulestr's options, minus forceset - RRuleTZ always parses into a set. */
type RRuleTZParseOptions = Omit<NonNullable<Parameters<typeof rrulestr>[1]>, 'forceset'>;

export class RRuleTZ {
  private readonly _rruleSet: RRuleSet;

  constructor(rule: string | RRule | RRuleSet, options?: RRuleTZParseOptions) {
    if (typeof rule === 'string') {
      try {
        this._rruleSet = rrulestr(rule, { ...options, forceset: true }) as RRuleSet;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new RRuleTZError(`Invalid rrule string: ${rule}\nReason: ${reason}`);
      }
    } else if (rule instanceof RRuleSet) {
      // .clone(), not the reference itself: the caller can still mutate their own RRuleSet
      // (rrule() / rdate() / ... are public mutators) after handing it to us, which must not
      // retroactively change what this instance answers.
      this._rruleSet = rule.clone();
    } else {
      // Building the set directly - rather than round-tripping through toString()+rrulestr() like
      // the string branch - avoids RFC 5545's DTSTART/RDATE/EXDATE text format, which has no
      // sub-second component: rrule's own iteration preserves milliseconds fine (verified), so the
      // old round-trip was truncating them for no reason.
      this._rruleSet = new RRuleSet();
      this._rruleSet.rrule(rule.clone());
    }

    // A DTSTART+RDATE-only set parses fine and answers queries, but the `rrule` getter throws, which
    // takes out half the API (lastExecutionUTC, occurrenceSize). Reject up front rather than hand
    // back an object that works for some calls and throws for others.
    if (this._rruleSet.rrules().length === 0) {
      throw new RRuleTZError('Unsupported rule: the set contains no RRULE. RRuleTZ wraps a recurrence rule.');
    }

    // Multiple RRULEs are supported - every query method iterates rruleSet directly.
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
    const firstExecLocalTime = this.rruleSet.after(MIN_DATE, true);
    if (!firstExecLocalTime) return null;

    return this.utcFromHostFloating(firstExecLocalTime);
  }

  lastExecutionUTC(): Date | null {
    // A last occurrence only exists if every RRULE eventually stops - one unbounded rule makes the
    // combined series run forever even if the others are finite.
    const allBounded = this.rruleSet.rrules().every(rule => isRuleBounded(rule.origOptions));
    if (!allBounded) return null;

    const lastExecLocalTime = this.rruleSet.before(MAX_DATE, true);
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
}
