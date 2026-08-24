export enum OccurrenceSize {
  /** The rule yields no occurrences at all (e.g. UNTIL precedes DTSTART). */
  NONE = 'NONE',
  ONE = 'ONE',
  MANY = 'MANY',
}

export enum OccurrencePosition {
  FIRST = 'FIRST',
  MIDDLE = 'MIDDLE',
  LAST = 'LAST',
}
