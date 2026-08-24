/** Whether `tzid` is a timezone name the runtime's ICU data recognizes (e.g. "Europe/Berlin"). */
export function isValidTimezone(tzid: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset (in ms) such that `date.getTime() + offset` yields `date`'s wall-clock fields
 * in `tzid`, expressed as UTC-labeled fields (i.e. `wall-clock-as-UTC - date`).
 */
function offsetMs(tzid: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const { type, value } of dtf.formatToParts(date)) parts[type] = value;

  const wallClockAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
    date.getUTCMilliseconds(),
  );
  return wallClockAsUtc - date.getTime();
}

/**
 * Given a real UTC instant, returns a Date whose UTC-labeled fields are the wall-clock
 * time in `tzid` (e.g. for handing a local time to code that expects "floating" UTC digits).
 * @param tzid - IANA timezone name (e.g. "Europe/Berlin")
 * @param date - A real UTC instant
 * @returns A Date whose UTC-labeled fields are `date`'s wall-clock time in `tzid`
 */
export function getLocalTimeInUtc(tzid: string, date: Date): Date {
  return new Date(date.getTime() + offsetMs(tzid, date));
}

/**
 * Inverse of getLocalTimeInUtc: given a Date whose UTC-labeled fields are wall-clock time
 * in `tzid`, returns the true UTC instant.
 * @param tzid - IANA timezone name (e.g. "Europe/Berlin")
 * @param date - A Date whose UTC-labeled fields are wall-clock time in `tzid`
 * @returns The true UTC instant
 */
export function getUtcTimeFromLocal(tzid: string, date: Date): Date {
  return new Date(date.getTime() - offsetMs(tzid, date));
}

/** The host machine's own IANA system timezone, resolved once at import time. */
export const MACHINE_LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
