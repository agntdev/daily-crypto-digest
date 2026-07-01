import { getStore, type PersistentStore } from "./store.js";
import { now } from "./clock.js";

/**
 * Durable user profile — subscription preferences and metadata.
 * Stored as a hash keyed by numeric telegram_id (as string).
 */

export interface UserProfile {
  telegramId: number;
  displayName: string;
  timezone: string; // IANA timezone string, e.g. "UTC", "America/New_York"
  deliveryTime: string; // "HH:MM" in the user's local time, e.g. "09:00"
  subscriptionStatus: "active" | "inactive";
  createdAt: number; // unix ms
  updatedAt: number; // unix ms
}

const USER_PROFILE_PREFIX = "user";
const USER_INDEX = "users:all";

function userKey(telegramId: number): string {
  return `up:${telegramId}`;
}

export async function getUserProfile(
  telegramId: number,
): Promise<UserProfile | undefined> {
  return getStore().kvGet<UserProfile>(userKey(telegramId));
}

export async function upsertUserProfile(
  profile: UserProfile,
): Promise<void> {
  const store = getStore();
  profile.updatedAt = now().getTime();
  await store.kvSet(userKey(profile.telegramId), profile);
  await store.setAdd(USER_INDEX, String(profile.telegramId));
}

export async function deleteUserProfile(telegramId: number): Promise<void> {
  const store = getStore();
  await store.kvDelete(userKey(telegramId));
  await store.setRemove(USER_INDEX, String(telegramId));
}

/** Count active subscribers (for admin reporting). Index-safe — uses set, not scan. */
export async function countActiveSubscribers(): Promise<number> {
  const store = getStore();
  const ids = await store.setMembers(USER_INDEX);
  let count = 0;
  for (const id of ids) {
    const p = await store.kvGet<UserProfile>(userKey(Number(id)));
    if (p && p.subscriptionStatus === "active") count++;
  }
  return count;
}

/** Count total users (for admin reporting). */
export async function countTotalUsers(): Promise<number> {
  return getStore().setCard(USER_INDEX);
}

/** Get all active subscriber IDs for delivery (reads the index, not a scan). */
export async function getActiveSubscriberIds(): Promise<number[]> {
  const store = getStore();
  const ids = await store.setMembers(USER_INDEX);
  const active: number[] = [];
  for (const id of ids) {
    const p = await store.kvGet<UserProfile>(userKey(Number(id)));
    if (p && p.subscriptionStatus === "active") active.push(Number(id));
  }
  return active;
}

/**
 * Delivery schedule — durable timing for each user.
 */

export interface DeliverySchedule {
  userId: number;
  localSendTime: string; // "HH:MM" in user's timezone
  nextScheduledSend: number; // unix ms
}

const SCHEDULE_INDEX = "schedules:all";

function scheduleKey(userId: number): string {
  return `sch:${userId}`;
}

export async function getSchedule(
  userId: number,
): Promise<DeliverySchedule | undefined> {
  return getStore().kvGet<DeliverySchedule>(scheduleKey(userId));
}

export async function upsertSchedule(
  schedule: DeliverySchedule,
): Promise<void> {
  const store = getStore();
  await store.kvSet(scheduleKey(schedule.userId), schedule);
  await store.setAdd(SCHEDULE_INDEX, String(schedule.userId));
}

export async function deleteSchedule(userId: number): Promise<void> {
  const store = getStore();
  await store.kvDelete(scheduleKey(userId));
  await store.setRemove(SCHEDULE_INDEX, String(userId));
}

/** Get all scheduled users who are due for delivery. */
export async function getDueSchedules(
  beforeMs: number,
): Promise<DeliverySchedule[]> {
  const store = getStore();
  const ids = await store.setMembers(SCHEDULE_INDEX);
  const due: DeliverySchedule[] = [];
  for (const id of ids) {
    const s = await store.kvGet<DeliverySchedule>(scheduleKey(Number(id)));
    if (s && s.nextScheduledSend <= beforeMs) due.push(s);
  }
  return due;
}

/**
 * Activity log — durable audit trail for admin reporting and error tracking.
 */

export type ActivityEventType =
  | "onboarding"
  | "delivery_sent"
  | "delivery_failed"
  | "unsubscribe"
  | "time_change"
  | "sample_request"
  | "feedback"
  | "error";

export interface ActivityLogEntry {
  eventType: ActivityEventType;
  timestamp: number; // unix ms
  userId?: number;
  details: string;
}

const ACTIVITY_LOG_INDEX = "activity:all";

function activityKey(id: number): string {
  return `act:${id}`;
}

export async function logActivity(entry: ActivityLogEntry): Promise<void> {
  const store = getStore();
  const id = await store.incr("activity:counter");
  await store.kvSet(activityKey(id), entry);
  await store.setAdd(ACTIVITY_LOG_INDEX, String(id));
}

/** Get recent activity log entries (newest first), for admin reporting. */
export async function getRecentActivity(
  limit = 100,
): Promise<ActivityLogEntry[]> {
  const store = getStore();
  const ids = await store.setMembers(ACTIVITY_LOG_INDEX);
  const entries: ActivityLogEntry[] = [];
  for (const id of ids) {
    const e = await store.kvGet<ActivityLogEntry>(activityKey(Number(id)));
    if (e) entries.push(e);
  }
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries.slice(0, limit);
}

/** Count deliveries in the last N ms. */
export async function countDeliveriesSince(sinceMs: number): Promise<number> {
  const store = getStore();
  const ids = await store.setMembers(ACTIVITY_LOG_INDEX);
  let count = 0;
  for (const id of ids) {
    const e = await store.kvGet<ActivityLogEntry>(activityKey(Number(id)));
    if (
      e &&
      e.eventType === "delivery_sent" &&
      e.timestamp >= sinceMs
    ) {
      count++;
    }
  }
  return count;
}

/** Count failed deliveries in the last N ms. */
export async function countFailuresSince(sinceMs: number): Promise<number> {
  const store = getStore();
  const ids = await store.setMembers(ACTIVITY_LOG_INDEX);
  let count = 0;
  for (const id of ids) {
    const e = await store.kvGet<ActivityLogEntry>(activityKey(Number(id)));
    if (
      e &&
      e.eventType === "delivery_failed" &&
      e.timestamp >= sinceMs
    ) {
      count++;
    }
  }
  return count;
}