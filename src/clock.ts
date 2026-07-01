/**
 * Clock — injectable time seam.
 *
 * The only way the bot gets the current time. Override `now` in tests to drive
 * time-based behavior (schedules, cutoffs, expiry). NEVER call new Date() /
 * Date.now() inline anywhere else in the bot.
 *
 * Example (in a test):
 *   import * as clock from "../src/clock.js";
 *   const orig = clock.now;
 *   clock.now = () => new Date("2026-07-01T12:00:00Z");
 *   // ... run test ...
 *   clock.now = orig; // restore
 */

export function now(): Date {
  return new Date();
}
