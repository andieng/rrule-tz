import * as rruleNamespace from 'rrule';

/**
 * Single interop point for the `rrule` peer dependency.
 *
 * rrule@2.x ships no `exports` field, so native Node ESM loads its CJS build and can't extract
 * named exports (`import { RRule } from 'rrule'` throws there). Reading the namespace and
 * unwrapping `.default` when present works under ESM, bundlers, and our own CJS output alike.
 * Import rrule through this module rather than directly, so the workaround lives in one place.
 */
type RRuleModule = typeof rruleNamespace;

const impl: RRuleModule = (rruleNamespace as RRuleModule & { default?: RRuleModule }).default ?? rruleNamespace;

// Re-exported as both a value and a type, since `export const` alone doesn't carry the type.
export const RRule = impl.RRule;
export const RRuleSet = impl.RRuleSet;
export const rrulestr = impl.rrulestr;
export const Weekday = impl.Weekday;

export type RRule = rruleNamespace.RRule;
export type RRuleSet = rruleNamespace.RRuleSet;
export type Weekday = rruleNamespace.Weekday;
export type { ByWeekday, Options } from 'rrule';
