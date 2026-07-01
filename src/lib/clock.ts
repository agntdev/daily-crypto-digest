/**
 * Injectable clock — route every schedule, cutoff, "today", expiry, and
 * late/on-time decision through this so tests can freeze time.
 */
let _now: () => Date = () => new Date();

/** Current time as a Date. */
export function now(): Date {
  return _now();
}

/** Current time as Unix milliseconds. */
export function nowMs(): number {
  return _now().getTime();
}

/** Override the clock (test-only hook). Pass no arg to restore the real clock. */
export function _setClock(fn?: () => Date): void {
  _now = fn ?? (() => new Date());
}
