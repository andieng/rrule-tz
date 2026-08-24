# rrule-tz

Timezone-safe ergonomics on top of [`rrule`](https://github.com/jkbrzt/rrule). `rrule` is a solid RFC 5545 implementation, but a few of its behaviors around `TZID` rules are easy to get wrong in production. `rrule-tz` wraps it to fix those specifically, and adds a small immutable editing API for common recurrence-rule edits.

## Install

```sh
npm install rrule-tz rrule
```

`rrule` is a peer dependency — rrule-tz is an add-on layered on top of it, not a replacement. Your app and rrule-tz share the one `rrule` install (no duplicated copy on disk), and the `RRule`/`RRuleSet` objects that rrule-tz hands back are instances of that same shared module, so `instanceof` checks against your own `rrule` imports keep working.

> [!WARNING]
> **If you link this package locally** (`npm link`, or `"rrule-tz": "file:../rrule-tz"`), that guarantee breaks. Node resolves rrule-tz's `rrule` import against _its own_ `node_modules` rather than yours, so two live copies of `rrule` exist. Objects built by one are unrecognized by the other, which surfaces as corrupted output rather than a clear error:
>
> ```
> RRULE:FREQ=WEEKLY;BYDAY=undefined,undefined,undefined
>                         ^ Weekday objects from copy A, serialized by copy B
> ```
>
> Point both at a single copy. For Jest:
>
> ```ts
> moduleNameMapper: { '^rrule$': '<rootDir>/node_modules/rrule' }
> ```
>
> A normal registry install is unaffected — the published package ships only `dist/`, with no bundled `rrule`.

## Quick start

```ts
import { RRuleTZ } from 'rrule-tz';

const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');

rule.firstExecutionUTC();
//=> 2026-02-11T08:00:00.000Z

rule.betweenUTC(new Date('2026-02-11T00:00:00Z'), new Date('2026-02-13T00:00:00Z'));
//=> [2026-02-11T08:00:00.000Z, 2026-02-12T08:00:00.000Z]

rule.excludeDate(new Date('2026-02-12T08:00:00.000Z'));
//=> a new RRuleTZ, unchanged except for an added EXDATE on 2026-02-12
```

All of the above is **independent of the host machine's timezone** — the same code returns the same UTC instants whether it runs on a laptop set to `Europe/Berlin` or a server set to `UTC`. Plain `rrule` does not give you that guarantee; see [problem 1](#1-rrule-rezones-all--before--after--between-to-the-host-machines-timezone) below.

> [!NOTE]
> **What this package does _not_ fix: the DST fold hour.** During a fall-back DST transition, a local wall-clock time occurs twice. In `Europe/Berlin` on 2026-10-25, clocks jump back from 03:00 CEST to 02:00 CET, so **02:00–03:00 local happens twice** — 02:30 is both `00:30Z` and `01:30Z`. Round-tripping a `Date` through a floating (timezone-mislabeled) representation during that hour is inherently ambiguous: no timezone library can losslessly resolve it, and this package doesn't pretend to. Avoid scheduling recurrence rules with `DTSTART`/occurrences that land in the repeated hour.

## The problems this fixes

### 1. rrule rezones `all()`/`before()`/`after()`/`between()` to the _host machine's_ timezone

If a `RRuleSet` has a `TZID`, calling `.all()`, `.between()`, `.before()`, or `.after()` on it directly does **not** interpret your query bounds in UTC, and does **not** interpret them in the rule's own `TZID` either — it silently uses whatever IANA timezone the _host machine_ happens to be running in. Move the same code from a laptop in `Europe/Berlin` to a Lambda running in `UTC`, and query results for the exact same rule and the exact same bounds change. `.all()` is affected too whenever the rule has an `EXDATE`/`RDATE` — the bug lives in how rrule resolves those against the host's `Intl.DateTimeFormat().resolvedOptions().timeZone`, not just in bound comparison.

```ts
import { RRule, RRuleSet, rrulestr } from 'rrule';

const set = rrulestr('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=1', {
  forceset: true,
}) as RRuleSet;

// What Date do you pass in? What timezone is the result in?
// The answer depends on process.env.TZ / the OS timezone — not on Europe/Berlin, not on UTC.
set.between(new Date('2026-02-10T00:00:00Z'), new Date('2026-02-12T00:00:00Z'), true);
```

`RRuleTZ.betweenUTC()` (and `allUTC`, `firstExecutionUTC`, `lastExecutionUTC`, `nextOccurrence`, `prevOccurrence`) take true UTC instants in, and return true UTC instants out — independent of the host machine's timezone, verified by tests that fake the system timezone across five different zones.

### 2. `BYDAY`/`UNTIL` are calendar-day-relative, not real-time instants

Converting a rule's wall-clock time into a different timezone can push `DTSTART` onto a different calendar day — 23:00 in Berlin is already the next day in Saigon. `BYDAY` and `UNTIL` are defined relative to the _local calendar date_, so naively converting them through a UTC instant produces a rule that fires on the wrong weekdays.

```ts
rule.convertToTimezone('Asia/Saigon');
// DTSTART 20260101T230000 (Mon 23:00 Berlin) -> 20260102T050000 (Tue 05:00 Saigon)
// BYDAY=MO,WE,FR correctly becomes BYDAY=TU,TH,SA — shifted by the same day the date rolled over
```

`convertToTimezone()` applies that shift consistently across the whole rule, not just `DTSTART`/`EXDATE`/`RDATE`:

- `BYDAY` and `UNTIL` shift by the day-delta (mod-7 wraparound for weekdays).
- `BYHOUR`/`BYMINUTE` shift by the offset delta itself (fractional-hour zones like `Asia/Kolkata` +5:30 included); `BYSECOND` passes through, since IANA offsets are whole minutes. When `BYHOUR` is present, the day-delta for the calendar fields comes from the occurrences' own midnight rollover, not `DTSTART`'s.
- `BYMONTHDAY`/`BYYEARDAY` shift with boundary wraparound where it has one stable meaning: `1 ↔ -1` (the 1st and last day exist in every month/year).
- `BYWEEKNO` shifts only when the weekday shift crosses the ISO Monday boundary.
- `EXRULE` lines get the same treatment, each with its own day-carry.

> [!NOTE]
> **What "converted" means here.** `convertToTimezone()` preserves the rule's _local wall-clock structure_ — a 09:00 Berlin rule becomes a 15:00 Saigon rule. It does not pin the occurrences to fixed instants forever. When the two zones don't observe DST identically, the two rules drift apart by the offset difference:
>
> ```ts
> // Berlin monthly at 09:00, converted to Asia/Ho_Chi_Minh (15:00, never shifts):
> // January - Berlin is CET (+1), the offset DTSTART was written at:
> //   Berlin 09:00 = 08:00Z ; Saigon 15:00 = 08:00Z   -> same instant
> // July - Berlin is CEST (+2):
> //   Berlin 09:00 = 07:00Z ; Saigon 15:00 = 08:00Z   -> one hour apart
> ```
>
> This is the intended behavior for "run this schedule at the same local time over there," which is what timezone conversion of a recurrence rule normally means. Just don't rely on it to keep two rules on identical instants across a DST boundary.

> [!IMPORTANT]
> A few value/shift combinations are genuinely not expressible as a single shifted RRULE, and `convertToTimezone()` throws `RRuleTZError` for those rather than producing a silently wrong rule: `BYHOUR`/`BYMINUTE` sets that a shift splits across midnight or an hour boundary (e.g. `BYHOUR=9,23` shifted +6h — one value rolls to the next day, the other doesn't); `BYMONTHDAY` values whose shifted position depends on the month's length (e.g. `31` shifted forward, `29` shifted backward); `BYYEARDAY=365/366` and mirrors, which depend on leap years; `BYWEEKNO` without `BYDAY` (it selects all 7 days of the week, whose shifted image is not a whole ISO week) or with weekdays that cross the ISO week boundary inconsistently.

### 3. No immutable editing API

Editing a recurrence rule with the raw `rrule` API means hand-rolling `RRuleSet` mutation and string round-tripping every time. `RRuleTZ` exposes the common edits as pure methods that return a new instance: `excludeDate()`, `moveStartAfter()`, `moveUntilBefore()` — see [API](#api) below.

### 4. No built-in IANA timezone validation

`isValidTimezone(tzid)` checks a timezone name against the runtime's ICU data via `Intl.DateTimeFormat`, so you can reject a bad `TZID` before it causes an obscure failure later. `convertToTimezone()` uses this internally.

### 5. No finiteness / position introspection

`occurrenceSize()` tells you whether a rule produces exactly one occurrence or many. `occurrencePosition(date)` tells you whether a given occurrence is the `FIRST`, `MIDDLE`, or `LAST` in the series — both without you having to manually branch on `COUNT`/`UNTIL`.

## API

```ts
import {
  RRuleTZ,
  RRuleTZError,
  OccurrenceSize,
  OccurrencePosition,
  getLocalTimeInUtc,
  getUtcTimeFromLocal,
  isValidTimezone,
} from 'rrule-tz';
```

### `RRuleTZ.init(rule: string | RRule | RRuleSet, options?): RRuleTZ`

Parses an iCalendar `RRULE`/`DTSTART` string — or takes an existing `RRule`/`RRuleSet` instance — into an `RRuleTZ`. Throws `RRuleTZError` if the string is malformed. The optional second argument passes through `rrulestr`'s parse options (e.g. `unfold` for RFC 5545 folded lines); `forceset` is always on.

```ts
import { RRule, datetime } from 'rrule';

const rule = RRuleTZ.init('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');

// or from rrule objects, e.g. built from an options object:
const sameRule = RRuleTZ.init(
  new RRule({ freq: RRule.DAILY, count: 5, dtstart: datetime(2026, 2, 11, 9), tzid: 'Europe/Berlin' }),
);
```

### `.rruleSet` / `.rrule`

The underlying `rrule` `RRuleSet` / `RRule` objects, for anything not covered by this API.

### `.betweenUTC(startAt: Date, endAt: Date): Date[]`

All occurrences in the inclusive `[startAt, endAt]` window, as true UTC instants.

```ts
rule.betweenUTC(new Date('2026-02-11T00:00:00Z'), new Date('2026-02-13T00:00:00Z'));
//=> [2026-02-11T08:00:00.000Z, 2026-02-12T08:00:00.000Z]
```

### `.allUTC(): Date[]`

Every occurrence of the rule, as true UTC instants. Throws `RRuleTZError` for an infinite rule — any `RRULE` in the set with no `COUNT`/`UNTIL` — instead of iterating forever; use `betweenUTC()` for those.

```ts
rule.allUTC();
//=> [2026-02-11T08:00:00.000Z, 2026-02-12T08:00:00.000Z, ...]
```

### `.firstExecutionUTC(): Date | null`

The rule's first occurrence, as a true UTC instant. `null` only if the rule has no occurrences at all.

```ts
rule.firstExecutionUTC();
//=> 2026-02-11T08:00:00.000Z
```

### `.lastExecutionUTC(): Date | null`

The rule's last occurrence, as a true UTC instant. `null` for a rule with no `COUNT`/`UNTIL` (i.e. one that recurs forever).

### `.nextOccurrence(referenceDate: Date, inc?: boolean): Date | undefined`

The first occurrence after `referenceDate`, or `undefined` if there isn't one. Pass `inc: true` to let `referenceDate` itself count as a match when it is an occurrence.

```ts
const rule = RRuleTZ.init('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
const occurrence = new Date('2026-02-12T09:00:00Z');

rule.nextOccurrence(occurrence);
//=> 2026-02-13T09:00:00.000Z   (strictly after)
rule.nextOccurrence(occurrence, true);
//=> 2026-02-12T09:00:00.000Z   (the reference date itself)
```

### `.prevOccurrence(referenceDate: Date, inc?: boolean): Date | undefined`

The last occurrence before `referenceDate`, or `undefined` if there isn't one. `inc` works as above.

### `.toString(): string`

The rule serialized back to its iCalendar string, including any `EXRULE`/`EXDATE`/`RDATE` lines. Equivalent to `.rruleSet.toString()`, and makes template interpolation work.

```ts
`${rule}`;
//=> 'DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=3'
```

### `.hasOccurrence(date: Date): boolean`

Whether `date` is exactly one of the rule's occurrences.

### `.rdatesUTC(): Date[]` / `.exdatesUTC(): Date[]`

The set's `RDATE`/`EXDATE` entries as true UTC instants. The raw `rruleSet.rdates()`/`.exdates()` return floating wall-clock digits for a `TZID` rule — the same representation pitfall the query methods above exist to avoid — so use these when you need the actual instants.

```ts
rule.exdatesUTC();
//=> [2026-02-12T08:00:00.000Z] for EXDATE;TZID=Europe/Berlin:20260212T090000
```

### `.occurrenceSize(): OccurrenceSize`

`OccurrenceSize.NONE` if the rule yields no occurrences at all (e.g. `UNTIL` precedes `DTSTART`), `OccurrenceSize.ONE` if its first and last occurrence are the same instant, `OccurrenceSize.MANY` otherwise (including infinite rules).

### `.occurrencePosition(date: Date): OccurrencePosition`

`OccurrencePosition.FIRST`, `MIDDLE`, or `LAST` for where `date` falls in the series. Throws `RRuleTZError` if `date` isn't one of the rule's occurrences.

### `.excludeDate(date: Date): RRuleTZ`

Returns a new `RRuleTZ` with `date` added as an `EXDATE`. Throws if `date` isn't one of the rule's occurrences.

```ts
rule.excludeDate(new Date('2026-02-12T08:00:00.000Z'));
```

### `.moveStartAfter(date: Date): RRuleTZ`

Returns a new `RRuleTZ` with `DTSTART` advanced to the occurrence after `date`, adjusting `COUNT` so the series still ends where it did. `date` must be the rule's _current first_ occurrence — this is enforced, and passing a later one throws. Use this instead of `excludeDate()` to drop the first occurrence, since there's nothing before it for an `EXDATE` to sit "between". Throws for a set with more than one `RRULE` — see [multiple RRULEs](#multiple-rrules).

### `.moveUntilBefore(date: Date): RRuleTZ`

Returns a new `RRuleTZ` truncated so it ends just before `date`: `UNTIL` becomes the exact instant of the occurrence preceding `date`, which keeps that one (RFC 5545 `UNTIL` is inclusive) and drops `date` itself. Throws if `date` isn't one of the rule's occurrences, or if there's no preceding occurrence to truncate to.

### `.convertToTimezone(newTzid: string): RRuleTZ`

Returns a new `RRuleTZ` expressing the same local schedule in `newTzid` (see the note in [problem 2](#2-bydayuntil-are-calendar-day-relative-not-real-time-instants) on what that does and doesn't guarantee across DST), shifting every calendar- and clock-relative field — `BYDAY`, `UNTIL`, `BYHOUR`, `BYMINUTE`, `BYMONTHDAY`, `BYYEARDAY`, `BYWEEKNO`, and any `EXRULE` — by the offset delta (see [problem 2](#2-bydayuntil-are-calendar-day-relative-not-real-time-instants)). Throws `RRuleTZError` if `newTzid` isn't a valid IANA timezone name, or for the few value/shift combinations RRULE syntax cannot express (see the callout above).

```ts
rule.convertToTimezone('Asia/Saigon');
```

### `isValidTimezone(tzid: string): boolean`

Whether `tzid` is a valid IANA timezone name (e.g. `"Europe/Berlin"`, not `"CET"` or `"GMT+1"`).

### `getLocalTimeInUtc(tzid: string, date: Date): Date` / `getUtcTimeFromLocal(tzid: string, date: Date): Date`

Low-level conversions between a true UTC instant and its "floating" wall-clock digits (a `Date` whose UTC-labeled fields are actually `tzid`'s local time) — the primitives `RRuleTZ` builds on. Most usage should reach for `RRuleTZ`'s methods instead; these are exported for building your own extensions (see below).

## Known limitations

Things this package deliberately does not solve. These are inherent rather than unfinished work, and all of them fail loudly rather than silently.

### The DST fold hour

Covered in the callout near the top. During a fall-back transition a local wall-clock time occurs twice, so a floating representation of it maps to two different instants with nothing to disambiguate them. No library can resolve this; avoid scheduling into the repeated hour.

### `BY*` values a timezone shift can't express

`convertToTimezone()` throws `RRuleTZError` rather than emit a rule that is quietly wrong. There is no valid RRULE for these cases:

| Case                                                                       | Why it can't be expressed                                                                                                                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BYHOUR`/`BYMINUTE` split by the shift, e.g. `BYHOUR=9,23` +6h             | 09:00 lands the same day, 23:00 lands the next. One rule applies the same hours to every day it selects, so "15:00 today and 05:00 tomorrow" is unsayable.                                 |
| `BYMONTHDAY` that depends on month length, e.g. `31` shifted +1            | "The day after the 31st" doesn't exist in February, and `BYMONTHDAY=1` would also fire after 30-day months — a different rule.                                                             |
| `BYYEARDAY=365`/`366` and their negative mirrors                           | In a leap year the 365th day is 30 December, so the shifted target changes with the year.                                                                                                  |
| `BYWEEKNO` without `BYDAY`                                                 | It selects all 7 days of the week; shifted by a day that becomes Tue–Mon, which spans two ISO weeks rather than being one.                                                                 |
| `BYWEEKNO` whose `BYDAY` values cross the ISO week boundary inconsistently | Some weekdays would move into a different week than others, which a single `BYWEEKNO` can't represent.                                                                                     |
| Ordinal `BYDAY`, e.g. `1SU` or `-1SU`                                      | "The day after the first Sunday" is not "the first Monday" — when the month opens on a Monday the two land weeks apart, dropping an occurrence.                                            |
| `BYSETPOS`                                                                 | It picks by position within each period, so moving the underlying weekdays re-anchors that position: `BYDAY=MO..FR;BYSETPOS=-1` ("last weekday of the month") would become "last Tue–Sat". |

Everything else shifts correctly — see [problem 2](#2-bydayuntil-are-calendar-day-relative-not-real-time-instants).

### `UNTIL` is serialized rrule-style, not RFC-style

For a rule with a `TZID`, RFC 5545 requires `UNTIL` to be a UTC timestamp ending in `Z`. `rrule` instead writes and reads it as local wall-clock digits with no suffix, and `rrule-tz` follows `rrule` so that values round-trip correctly through the library that actually evaluates them:

```
DTSTART;TZID=Europe/Berlin:20260211T090000
RRULE:FREQ=DAILY;UNTIL=20260213T090000      ← local digits, no Z
```

This is self-consistent within `rrule`/`rrule-tz`. But if you hand `rule.toString()` to a _different_ iCalendar implementation — ical.js, python-dateutil, Google Calendar — it will read that `UNTIL` as UTC and end the series at an instant off by the zone's offset. Convert `UNTIL` to a real UTC timestamp before exporting to any non-`rrule` consumer.

### Multiple RRULEs

A set can combine more than one `RRULE` (e.g. "every Monday" _and_ "the 1st of every month"). Every query method (`betweenUTC`, `allUTC`, `hasOccurrence`, `occurrenceSize`, ...) and `excludeDate`/`convertToTimezone` handle this correctly — `allUTC()`/`lastExecutionUTC()` require every `RRULE` to be bounded, and `convertToTimezone()` shifts each `RRULE` independently (the same treatment it already gives `EXRULE`s).

`moveStartAfter()` is the one exception: `DTSTART` is a single line shared by every `RRULE` in the set, so moving it moves every rule's start at once — for a `WEEKLY`/`MONTHLY`/`YEARLY` rule with no explicit `BYDAY`/`BYMONTHDAY`, that can silently change its derived calendar position too (the same hazard [problem 2](#2-bydayuntil-are-calendar-day-relative-not-real-time-instants) guards against for timezone conversion). It throws `RRuleTZError` for a multi-`RRULE` set — use `excludeDate()` on the individual occurrence instead. `EXRULE`, `EXDATE` and `RDATE` are all supported throughout.

## Building app-specific extensions

This package intentionally stays generic (no app-specific business rules). If your app has its own recurrence conventions (say, normalizing a rule's `DTSTART` onto a rolling weekly window, or mapping a rule to a device's own weekday/time wire format), build that as a thin layer on top of `RRuleTZ` in your own codebase rather than re-solving the `TZID` rezoning problem.

Subclassing is supported for exactly this. Beyond the public API, subclasses get:

- `this.tzid` — the rule's own IANA timezone, or `null` for a floating/UTC rule.
- `this.ruleFloatingFromUtc(instant)` (`protected`) — a true UTC instant to floating wall-clock digits in the rule's timezone, for building new `DTSTART`/`EXDATE`/`RDATE` values.
- `this.utcFromRuleFloating(floating)` (`protected`) — the inverse.

```ts
import { RRuleTZ } from 'rrule-tz';

class DeviceRuleHelper extends RRuleTZ {
  toDeviceWireFormat() {
    const { dtstart } = this.rrule.origOptions;
    const utcDtstart = this.utcFromRuleFloating(dtstart!);
    // ...map BYDAY/time into the device's own format
  }

  static init(str: string): DeviceRuleHelper {
    return new DeviceRuleHelper(str);
  }
}
```

The immutable edit methods (`excludeDate`, `moveStartAfter`, `moveUntilBefore`, `convertToTimezone`) are typed to return `this`, and construct the result with your own constructor — so a subclass survives an edit and its methods stay available:

```ts
const rule = DeviceRuleHelper.init(ruleString);
rule.excludeDate(occurrence).toDeviceWireFormat(); // still a DeviceRuleHelper
```

If your subclass validates in its constructor, note that the validation therefore runs again on every edit result.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```
