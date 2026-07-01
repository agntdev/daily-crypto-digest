/**
 * Injectable clock seam — route every "now", "today", expiry, and
 * late/on-time decision through `clock.now()` instead of calling
 * `new Date()` / `Date.now()` inline. Override in tests.
 */
export type Clock = {
  now(): Date;
};

/** Default clock: returns the real current time. */
export const realClock: Clock = {
  now: () => new Date(),
};

/** Application-global clock reference. Swap in tests. */
let currentClock: Clock = realClock;

/** Get the current clock. */
export function clock(): Clock {
  return currentClock;
}

/** Override the clock (test only). Returns the previous clock. */
export function setClock(c: Clock): Clock {
  const prev = currentClock;
  currentClock = c;
  return prev;
}

/** Reset clock to real time. */
export function resetClock(): void {
  currentClock = realClock;
}

/** Convenience: current timestamp in ms. */
export function nowMs(): number {
  return currentClock.now().getTime();
}

/** Convenience: current timestamp in seconds. */
export function nowSec(): number {
  return Math.floor(nowMs() / 1000);
}
