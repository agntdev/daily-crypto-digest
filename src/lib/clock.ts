/**
 * Injectable clock seam — route every schedule, cutoff, "today", expiry, and
 * late/on-time decision through this instead of calling new Date() / Date.now()
 * inline. Override in tests via setNow().
 */

export type NowFn = () => Date;

let _now: NowFn = () => new Date();

/** Current date/time for all time-based decisions in the bot. */
export function now(): Date {
  return _now();
}

/** Override the clock (for tests). Returns the previous function. */
export function setNow(fn: NowFn): NowFn {
  const prev = _now;
  _now = fn;
  return prev;
}

/** Reset to the real clock. */
export function resetNow(): void {
  _now = () => new Date();
}

/** Format HH:MM from a Date in a given IANA timezone. */
export function formatHHMM(date: Date, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  };
  return new Intl.DateTimeFormat("en-US", opts).format(date);
}

/** Get current weekday (0=Sun) in a given timezone. */
export function currentWeekday(date: Date, tz: string): number {
  // Use getDay() in the target timezone by formatting the full date string
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    timeZone: tz,
  };
  const dayName = new Intl.DateTimeFormat("en-US", opts).format(date);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return days.indexOf(dayName);
}

/** Format a Date as YYYY-MM-DD string in a given timezone (or UTC by default). */
export function formatYYYYMMDD(date: Date, tz = "UTC"): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  };
  return new Intl.DateTimeFormat("en-CA", opts).format(date); // en-CA → YYYY-MM-DD
}

/** Get timezone offset description for display. */
export function describeTimezone(tz: string): string {
  try {
    const d = new Date();
    const opts: Intl.DateTimeFormatOptions = {
      timeZone: tz,
      timeZoneName: "shortOffset" as const,
    };
    return new Intl.DateTimeFormat("en-US", opts).format(d);
  } catch {
    return "UTC";
  }
}