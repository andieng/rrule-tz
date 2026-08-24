# rrule-tz

[![npm version](https://img.shields.io/npm/v/rrule-tz.svg)](https://www.npmjs.com/package/rrule-tz)
[![CI](https://github.com/andieng/rrule-tz/actions/workflows/ci.yml/badge.svg)](https://github.com/andieng/rrule-tz/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/rrule-tz.svg)](./LICENSE)

Timezone-safe occurrence queries on top of [`rrule`](https://github.com/jkbrzt/rrule). `rrule` is a solid RFC 5545 implementation, but querying a `TZID` rule's occurrences silently depends on the **host machine's** timezone instead of the rule's own — move the same code from a laptop to a server in another zone and results change. `rrule-tz` fixes exactly that.

```ts
import { RRuleTZ } from 'rrule-tz';

const rule = new RRuleTZ('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');

rule.firstExecutionUTC();
//=> 2026-02-11T08:00:00.000Z   (same result everywhere, regardless of host timezone)
```

> **Note:** This release covers **occurrence queries only** (`betweenUTC`, `allUTC`, `firstExecutionUTC`, etc.). Immutable rule editing (`excludeDate`, `moveStartAfter`, `moveUntilBefore`) and cross-timezone rule conversion (`convertToTimezone`) aren't in this release yet — see [Roadmap](#roadmap).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The problem this fixes](#the-problem-this-fixes)
- [API](#api)
- [Known limitations](#known-limitations)
- [Building app-specific extensions](#building-app-specific-extensions)
- [Roadmap](#roadmap)
- [Development](#development)

## Install

```sh
npm install rrule-tz rrule
```

`rrule` is a peer dependency, so the `RRule`/`RRuleSet` objects rrule-tz hands back are instances of your own `rrule` install — `instanceof` checks against it keep working.

## Quick start

```ts
import { RRuleTZ } from 'rrule-tz';

const rule = new RRuleTZ('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');

rule.firstExecutionUTC();
//=> 2026-02-11T08:00:00.000Z

rule.betweenUTC(new Date('2026-02-11T00:00:00Z'), new Date('2026-02-13T00:00:00Z'));
//=> [2026-02-11T08:00:00.000Z, 2026-02-12T08:00:00.000Z]
```

All of the above is **independent of the host machine's timezone** — the same code returns the same UTC instants whether it runs on a laptop set to `Europe/Berlin` or a server set to `UTC`. Plain `rrule` does not give you that guarantee; see [the problem this fixes](#the-problem-this-fixes) below.

> **Note:** this package does **not** fix the DST fold hour. During a fall-back DST transition, a local wall-clock time occurs twice. In `Europe/Berlin` on 2026-10-25, clocks jump back from 03:00 CEST to 02:00 CET, so **02:00–03:00 local happens twice** — 02:30 is both `00:30Z` and `01:30Z`. Round-tripping a `Date` through a floating (timezone-mislabeled) representation during that hour is inherently ambiguous: no timezone library can losslessly resolve it, and this package doesn't pretend to. Avoid scheduling recurrence rules with `DTSTART`/occurrences that land in the repeated hour.

## The problem this fixes

### rrule rezones `all()`/`before()`/`after()`/`between()` to the _host machine's_ timezone

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

`RRuleTZ.betweenUTC()` (and `allUTC`, `firstExecutionUTC`, `lastExecutionUTC`, `nextOccurrence`, `prevOccurrence`) take true UTC instants in, and return true UTC instants out — independent of the host machine's timezone. Verified by tests that fake the system timezone across five zones, plus CI running the whole suite under `UTC`, `America/New_York`, `Pacific/Kiritimati` (+14:00) and `Asia/Kathmandu` (+05:45) with a real `TZ` set, not a mock.

### No built-in IANA timezone validation

`isValidTimezone(tzid)` checks a timezone name against the runtime's ICU data via `Intl.DateTimeFormat`, so you can reject a bad `TZID` before it causes an obscure failure later.

### No finiteness / position introspection

`occurrenceSize()` tells you whether a rule produces no occurrences, exactly one, or many. `occurrencePosition(date)` tells you whether a given occurrence is the `FIRST`, `MIDDLE`, or `LAST` in the series — both without you having to manually branch on `COUNT`/`UNTIL`.

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
  machineLocalTz,
} from 'rrule-tz';
```

| Method                                                                                        | Returns              | What it does                                              |
| --------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------- |
| [`new RRuleTZ(rule, options?)`](#new-rruletzrule-string--rrule--rruleset-options)             | `RRuleTZ`            | Parse a rule string or object into an `RRuleTZ`.          |
| [`.betweenUTC(startAt, endAt)`](#betweenutcstartat-date-endat-date-date)                      | `Date[]`             | Occurrences within an inclusive window.                   |
| [`.allUTC()`](#allutc-date)                                                                   | `Date[]`             | Every occurrence (throws if the rule is unbounded).       |
| [`.firstExecutionUTC()`](#firstexecutionutc-date--null)                                       | `Date \| null`       | The rule's first occurrence.                              |
| [`.lastExecutionUTC()`](#lastexecutionutc-date--null)                                         | `Date \| null`       | The rule's last occurrence, or `null` if unbounded.       |
| [`.nextOccurrence(ref, inc?)`](#nextoccurrencereferencedate-date-inc-boolean-date--undefined) | `Date \| undefined`  | The first occurrence after `ref`.                         |
| [`.prevOccurrence(ref, inc?)`](#prevoccurrencereferencedate-date-inc-boolean-date--undefined) | `Date \| undefined`  | The last occurrence before `ref`.                         |
| [`.hasOccurrence(date)`](#hasoccurrencedate-date-boolean)                                     | `boolean`            | Whether `date` is exactly one of the rule's occurrences.  |
| [`.rdatesUTC()` / `.exdatesUTC()`](#rdatesutc-date--exdatesutc-date)                          | `Date[]`             | The rule's `RDATE`/`EXDATE` entries as true UTC instants. |
| [`.occurrenceSize()`](#occurrencesize-occurrencesize)                                         | `OccurrenceSize`     | `NONE` / `ONE` / `MANY`.                                  |
| [`.occurrencePosition(date)`](#occurrencepositiondate-date-occurrenceposition)                | `OccurrencePosition` | `FIRST` / `MIDDLE` / `LAST` for a given occurrence.       |
| [`.toString()`](#tostring-string)                                                             | `string`             | Serializes back to the iCalendar string.                  |

### `new RRuleTZ(rule: string | RRule | RRuleSet, options?)`

Parses an iCalendar `RRULE`/`DTSTART` string — or takes an existing `RRule`/`RRuleSet` instance — into an `RRuleTZ`. Throws `RRuleTZError` if the string is malformed, or if the set has no `RRULE`. The optional second argument passes through `rrulestr`'s parse options (e.g. `unfold` for RFC 5545 folded lines); `forceset` is always on.

```ts
import { RRule, datetime } from 'rrule';

const rule = new RRuleTZ('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');

// or from rrule objects, e.g. built from an options object:
const sameRule = new RRuleTZ(
  new RRule({ freq: RRule.DAILY, count: 5, dtstart: datetime(2026, 2, 11, 9), tzid: 'Europe/Berlin' }),
);
```

A set can combine more than one `RRULE` (e.g. "every Monday" _and_ "the 1st of every month") — every method below handles that correctly via `rruleSet`'s own combined iteration; `allUTC()`/`lastExecutionUTC()` require every `RRULE` in the set to be bounded.

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

The rule's last occurrence, as a true UTC instant. `null` if any `RRULE` in the set has no `COUNT`/`UNTIL` (i.e. the combined series recurs forever).

### `.nextOccurrence(referenceDate: Date, inc?: boolean): Date | undefined`

The first occurrence after `referenceDate`, or `undefined` if there isn't one. Pass `inc: true` to let `referenceDate` itself count as a match when it is an occurrence.

```ts
const rule = new RRuleTZ('DTSTART:20260211T090000Z\nRRULE:FREQ=DAILY;COUNT=3');
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

### `isValidTimezone(tzid: string): boolean`

Whether `tzid` is a valid IANA timezone name (e.g. `"Europe/Berlin"`, not `"CET"` or `"GMT+1"`).

### `getLocalTimeInUtc(tzid: string, date: Date): Date` / `getUtcTimeFromLocal(tzid: string, date: Date): Date`

Low-level conversions between a true UTC instant and its "floating" wall-clock digits (a `Date` whose UTC-labeled fields are actually `tzid`'s local time) — the primitives `RRuleTZ` builds on. Most usage should reach for `RRuleTZ`'s methods instead; these are exported for building your own extensions (see below).

### `machineLocalTz(): string`

The host machine's own IANA system timezone, resolved fresh on every call rather than cached — `RRuleTZ` uses this internally so a `TZ` change after import (routine in test setups) is always picked up. Exported for the same reason as the two functions above: building your own extensions.

## Known limitations

**The DST fold hour**, covered in the callout near the top: during a fall-back transition a local wall-clock time occurs twice, so a floating representation of it maps to two different instants with nothing to disambiguate them. No library can resolve this; avoid scheduling into the repeated hour.

**Sub-second precision is dropped when constructing from a `DTSTART`/`RDATE`/`EXDATE` string.** RFC 5545's iCalendar text format has no sub-second component, so a string like `DTSTART:20260211T090000Z` never had milliseconds to lose in the first place — this is a property of the format, not this package. Constructing from an already-parsed `RRule`/`RRuleSet` instance is unaffected: the `RRuleTZ` constructor uses that instance directly (`.clone()`d, so later mutating your own copy doesn't retroactively change what the instance answers) rather than round-tripping it through a string.

**`RDATE`/`EXDATE` lines with a `TZID` different from `DTSTART`'s are silently reinterpreted using `DTSTART`'s zone.** This is an `rrule` parsing limitation, not one introduced here — the per-line `TZID` is discarded at parse time rather than used to compute the instant, so `EXDATE;TZID=America/New_York:...` on a `DTSTART;TZID=Europe/Berlin` rule excludes the wrong UTC instant with no error. Always give every `RDATE`/`EXDATE` line the same `TZID` as `DTSTART` (or none, for a UTC/floating rule).

## Building app-specific extensions

This package intentionally stays generic (no app-specific business rules). If your app has its own recurrence conventions (say, mapping a rule to a device's own weekday/time wire format), build that as a thin layer on top of `RRuleTZ` in your own codebase rather than re-solving the `TZID` rezoning problem.

Subclassing is supported for exactly this. Beyond the public API, subclasses get:

- `this.tzid` — the rule's own IANA timezone, or `null` for a floating/UTC rule.
- `this.ruleFloatingFromUtc(instant)` (`protected`) — a true UTC instant to floating wall-clock digits in the rule's timezone.
- `this.utcFromRuleFloating(floating)` (`protected`) — the inverse.

```ts
import { RRuleTZ } from 'rrule-tz';

class DeviceRuleHelper extends RRuleTZ {
  toDeviceWireFormat() {
    const { dtstart } = this.rrule.origOptions;
    const utcDtstart = this.utcFromRuleFloating(dtstart!);
    // ...map BYDAY/time into the device's own format
  }
}

const rule = new DeviceRuleHelper('DTSTART;TZID=Europe/Berlin:20260211T090000\nRRULE:FREQ=DAILY;COUNT=5');
```

## Roadmap

Immutable rule editing (`excludeDate`, `moveStartAfter`, `moveUntilBefore`) and `convertToTimezone` (cross-timezone rule conversion, including `BYDAY`/`BYMONTHDAY`/`BYHOUR` shifting) exist on a separate branch. They're deferred from this release because, unlike the query methods above, their test coverage is entirely example-based rather than property-based over the `FREQ` × `BY*` × multi-`RRULE` combinatorial space — four rounds of review each found real defects in that area, including one round that introduced a bug while fixing another. They'll ship once that branch has systematic (generated, not hand-picked) test coverage.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```
