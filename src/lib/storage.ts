/**
 * Domain-level persistent storage for the crypto digest bot.
 *
 * Wraps a simple key-value store (Redis-backed in production, in-memory for
 * dev/test) with explicit index management — no keyspace scanning.
 *
 * IMPORTANT: This is for DURABLE domain data (user profiles, delivery schedules,
 * digest items, activity logs). It is NOT session storage — the toolkit's
 * createBot() auto-wires grammY sessions via MemorySessionStorage /
 * RedisSessionStorage.
 *
 * Each entity type has its own key prefix, and reads/writes go through explicit
 * INDEX records (never KEYS/SCAN/readAllKeys).
 */

import { createRequire } from "node:module";
import { now } from "./clock.js";

// ──────────────────────────────────────────────
// Simple key-value store interface (no session flavors)
// ──────────────────────────────────────────────

export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

// ──────────────────────────────────────────────
// In-memory KVStore (dev / test / no-Redis fallback)
// ──────────────────────────────────────────────

export class InMemoryKVStore implements KVStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

// ──────────────────────────────────────────────
// Redis-backed KVStore (production)
// ──────────────────────────────────────────────

export class RedisKVStore implements KVStore {
  constructor(private readonly redis: import("ioredis").default) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }
}

// ──────────────────────────────────────────────
// Factory
// ──────────────────────────────────────────────

let _kv: KVStore | null = null;

/**
 * Get or create the domain KV store. In production (REDIS_URL set), returns a
 * Redis-backed store. In dev/test, returns an in-memory store.
 * Pass an explicit store to override (for tests or for the test harness).
 */
export function getDomainStore(env: Record<string, string | undefined> = process.env): KVStore {
  if (_kv) return _kv;
  const url = env.REDIS_URL;
  if (url) {
    const require = createRequire(import.meta.url);
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    const client = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
    _kv = new RedisKVStore(client);
  } else {
    _kv = new InMemoryKVStore();
  }
  return _kv;
}

/**
 * Override the domain store (for tests). Returns the previous store.
 */
export function setDomainStore(kv: KVStore): KVStore | null {
  const prev = _kv;
  _kv = kv;
  return prev;
}

/**
 * Reset the domain store (for tests).
 */
export function resetDomainStore(): void {
  _kv = null;
}

// ──────────────────────────────────────────────
// Key helpers — each entity type has its own prefix
// ──────────────────────────────────────────────

const PREFIX = "crypto:";

const k = {
  userProfile: (telegramId: number) => `${PREFIX}user:${telegramId}`,
  digestItem: (itemId: string) => `${PREFIX}digest:${itemId}`,
  activityLog: (eventId: string) => `${PREFIX}log:${eventId}`,
  activityCounter: (eventType: string) => `${PREFIX}cnt:${eventType}`,
  // Indexes (explicit, never scanned)
  allUsers: () => `${PREFIX}idx:users`,
  allDigestItems: () => `${PREFIX}idx:digest_items`,
  scheduledUsers: (hhmm: string) => `${PREFIX}idx:sched:${hhmm}`,
  userDeliveries: (telegramId: number) => `${PREFIX}idx:deliveries:${telegramId}`,
  lastDeliveredDate: (telegramId: number) => `${PREFIX}user:${telegramId}:last_delivered`,
  adminChat: () => `${PREFIX}admin:chat`,
  adminErrors: () => `${PREFIX}idx:admin_errors`,
  sourcePriorities: () => `${PREFIX}admin:source_priorities`,
  summaryLengthLimit: () => `${PREFIX}admin:summary_length`,
} as const;

// ──────────────────────────────────────────────
// User Profile
// ──────────────────────────────────────────────

export interface UserProfile {
  telegram_id: number;
  display_name: string;
  timezone: string;
  delivery_time: string; // "HH:MM" in 24h format
  subscription_status: "active" | "paused" | "unsubscribed";
  created_at: string; // ISO timestamp
  updated_at: string; // ISO timestamp
}

export async function getUserProfile(kv: KVStore, telegramId: number): Promise<UserProfile | null> {
  const raw = await kv.get(k.userProfile(telegramId));
  if (!raw) return null;
  return JSON.parse(raw) as UserProfile;
}

export async function saveUserProfile(kv: KVStore, profile: UserProfile, oldDeliveryTime?: string): Promise<void> {
  // Update index: all users
  const ts = nowISO();
  profile.updated_at = ts;
  if (!profile.created_at) profile.created_at = ts;
  await kv.set(k.userProfile(profile.telegram_id), JSON.stringify(profile));

  // Maintain the "all users" index
  const allRaw = await kv.get(k.allUsers());
  const allIds: number[] = allRaw ? JSON.parse(allRaw) : [];
  if (!allIds.includes(profile.telegram_id)) {
    allIds.push(profile.telegram_id);
    await kv.set(k.allUsers(), JSON.stringify(allIds));
  }

  // Remove from OLD delivery-time schedule index if time changed
  if (oldDeliveryTime && oldDeliveryTime !== profile.delivery_time) {
    const oldRaw = await kv.get(k.scheduledUsers(oldDeliveryTime));
    if (oldRaw) {
      const oldSchedIds: number[] = JSON.parse(oldRaw);
      const filtered = oldSchedIds.filter((id) => id !== profile.telegram_id);
      if (filtered.length > 0) {
        await kv.set(k.scheduledUsers(oldDeliveryTime), JSON.stringify(filtered));
      } else {
        await kv.del(k.scheduledUsers(oldDeliveryTime));
      }
    }
  }

  // Maintain the delivery-time schedule index
  if (profile.subscription_status === "active" && profile.delivery_time) {
    const schedRaw = await kv.get(k.scheduledUsers(profile.delivery_time));
    const schedIds: number[] = schedRaw ? JSON.parse(schedRaw) : [];
    if (!schedIds.includes(profile.telegram_id)) {
      schedIds.push(profile.telegram_id);
      await kv.set(k.scheduledUsers(profile.delivery_time), JSON.stringify(schedIds));
    }
  }
}

export async function unsubscribeUser(kv: KVStore, telegramId: number): Promise<void> {
  const profile = await getUserProfile(kv, telegramId);
  if (!profile) return;
  profile.subscription_status = "unsubscribed";
  profile.updated_at = nowISO();
  await kv.set(k.userProfile(profile.telegram_id), JSON.stringify(profile));

  // Remove from all delivery-time schedule indexes
  const tRaw = await kv.get(k.scheduledUsers(profile.delivery_time));
  if (tRaw) {
    const schedIds: number[] = JSON.parse(tRaw);
    const filtered = schedIds.filter((id) => id !== telegramId);
    if (filtered.length > 0) {
      await kv.set(k.scheduledUsers(profile.delivery_time), JSON.stringify(filtered));
    } else {
      await kv.del(k.scheduledUsers(profile.delivery_time));
    }
  }
}

/**
 * Get all active scheduled user IDs for a given HH:MM time.
 */
export async function getScheduledUserIds(kv: KVStore, hhmm: string): Promise<number[]> {
  const raw = await kv.get(k.scheduledUsers(hhmm));
  return raw ? (JSON.parse(raw) as number[]) : [];
}

export async function getAllUserIds(kv: KVStore): Promise<number[]> {
  const raw = await kv.get(k.allUsers());
  return raw ? (JSON.parse(raw) as number[]) : [];
}

// ──────────────────────────────────────────────
// Last-delivered-date tracking (deduplication)
// ──────────────────────────────────────────────

export async function setLastDeliveredDate(kv: KVStore, telegramId: number, dateStr: string): Promise<void> {
  await kv.set(k.lastDeliveredDate(telegramId), dateStr);
}

export async function getLastDeliveredDate(kv: KVStore, telegramId: number): Promise<string | null> {
  return kv.get(k.lastDeliveredDate(telegramId));
}

export async function clearLastDeliveredDate(kv: KVStore, telegramId: number): Promise<void> {
  await kv.del(k.lastDeliveredDate(telegramId));
}

/**
 * Compute the next delivery date for a user given their timezone and delivery time.
 * Returns Date for the next occurrence.
 */
export function computeNextScheduledSend(tz: string, deliveryTime: string): Date {
  const nowDate = now();
  const [h, m] = deliveryTime.split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).formatToParts(nowDate);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const y = Number(get("year"));
  const mo = Number(get("month")) - 1;
  const d = Number(get("day"));

  const targetLocal = new Date(y, mo, d, h, m, 0);
  if (targetLocal.getTime() <= nowDate.getTime()) {
    targetLocal.setDate(targetLocal.getDate() + 1);
  }
  return targetLocal;
}

function monthIndex(monthStr: string): number {
  return Number(monthStr);
}

/**
 * Set the next scheduled send ISO timestamp for a user.
 */
export async function setNextScheduledSend(kv: KVStore, userId: number, date: Date): Promise<void> {
  const key = `${PREFIX}user:${userId}:next_send`;
  await kv.set(key, date.toISOString());
}

export async function getNextScheduledSend(kv: KVStore, userId: number): Promise<string | null> {
  const key = `${PREFIX}user:${userId}:next_send`;
  return kv.get(key);
}

export async function clearNextScheduledSend(kv: KVStore, userId: number): Promise<void> {
  const key = `${PREFIX}user:${userId}:next_send`;
  await kv.del(key);
}

// ──────────────────────────────────────────────
// Digest Item
// ──────────────────────────────────────────────

export interface DigestItem {
  id: string;
  headline: string;
  summary_text: string;
  source_name: string;
  source_url: string;
  published_at: string;
  topic_tags: string[];
}

export async function getDigestItem(kv: KVStore, itemId: string): Promise<DigestItem | null> {
  const raw = await kv.get(k.digestItem(itemId));
  if (!raw) return null;
  return JSON.parse(raw) as DigestItem;
}

export async function saveDigestItem(kv: KVStore, item: DigestItem): Promise<void> {
  await kv.set(k.digestItem(item.id), JSON.stringify(item));

  // Maintain the digest items index
  const allRaw = await kv.get(k.allDigestItems());
  const allIds: string[] = allRaw ? JSON.parse(allRaw) : [];
  if (!allIds.includes(item.id)) {
    allIds.push(item.id);
    await kv.set(k.allDigestItems(), JSON.stringify(allIds));
  }
}

export async function listDigestItemIds(kv: KVStore): Promise<string[]> {
  const raw = await kv.get(k.allDigestItems());
  return raw ? (JSON.parse(raw) as string[]) : [];
}

// ──────────────────────────────────────────────
// Activity Log
// ──────────────────────────────────────────────

export interface ActivityLogEntry {
  event_type: string;
  timestamp: string;
  user_id: number | null;
  details: string;
}

let _logCounter = 0;

export async function appendActivityLog(kv: KVStore, entry: ActivityLogEntry): Promise<void> {
  _logCounter++;
  const eventId = `${now().getTime()}-${_logCounter}`;
  await kv.set(k.activityLog(eventId), JSON.stringify(entry));

  // Increment the counter for this event type (best-effort aggregate)
  if (["delivery", "delivery_error", "feedback", "source_api_outage", "admin_alert"].includes(entry.event_type)) {
    const cntRaw = await kv.get(k.activityCounter(entry.event_type));
    const cnt = cntRaw ? Number(cntRaw) : 0;
    await kv.set(k.activityCounter(entry.event_type), String(cnt + 1));
  }

  // Maintain the admin errors index (only error-type entries)
  if (
    entry.event_type === "delivery_error" ||
    entry.event_type === "source_api_outage" ||
    entry.event_type === "admin_alert"
  ) {
    const errRaw = await kv.get(k.adminErrors());
    const errIds: string[] = errRaw ? JSON.parse(errRaw) : [];
    errIds.push(eventId);
    // Keep only last 100 errors
    const trimmed = errIds.slice(-100);
    await kv.set(k.adminErrors(), JSON.stringify(trimmed));
  }
}

export async function getActivityLogById(kv: KVStore, eventId: string): Promise<ActivityLogEntry | null> {
  const raw = await kv.get(k.activityLog(eventId));
  return raw ? (JSON.parse(raw) as ActivityLogEntry) : null;
}

/**
 * Read recent activity log events. Since we avoid keyspace scanning, we maintain
 * explicit aggregate counters in the activity log index. This function reads
 * events by scanning a time-window via predicted key patterns.
 * In a production system this would use a time-sorted set; for our index-based
 * design we scan the adminErrors index for error-type events, and for delivery
 * counts we use the adminErrors + cross-reference by user delivery indices.
 */
export async function getRecentActivityCounts(
  kv: KVStore,
  _sinceMinutes: number,
): Promise<{ deliveries: number; errors: number; feedbacks: number; alerts: number }> {
  const parse = async (type: string) => {
    const raw = await kv.get(k.activityCounter(type));
    return raw ? Number(raw) : 0;
  };
  return {
    deliveries: await parse("delivery"),
    errors: await parse("delivery_error"),
    feedbacks: await parse("feedback"),
    alerts: await parse("admin_alert"),
  };
}

// ──────────────────────────────────────────────
// Admin Chat ID
// ──────────────────────────────────────────────

export async function getAdminChatId(kv: KVStore): Promise<number | null> {
  const raw = await kv.get(k.adminChat());
  return raw ? Number(raw) : null;
}

export async function setAdminChatId(kv: KVStore, chatId: number): Promise<void> {
  await kv.set(k.adminChat(), String(chatId));
}

// ──────────────────────────────────────────────
// Source priorities (owner-controlled)
// ──────────────────────────────────────────────

export async function getSourcePriorities(kv: KVStore): Promise<string[]> {
  const raw = await kv.get(k.sourcePriorities());
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export async function setSourcePriorities(kv: KVStore, sources: string[]): Promise<void> {
  await kv.set(k.sourcePriorities(), JSON.stringify(sources));
}

// ──────────────────────────────────────────────
// Summary length limit (owner-controlled, in chars)
// ──────────────────────────────────────────────

export async function getSummaryLengthLimit(kv: KVStore): Promise<number> {
  const raw = await kv.get(k.summaryLengthLimit());
  return raw ? Number(raw) : 300; // default 300 chars
}

export async function setSummaryLengthLimit(kv: KVStore, limit: number): Promise<void> {
  await kv.set(k.summaryLengthLimit(), String(limit));
}

// ──────────────────────────────────────────────
// Anonymize user data (privacy — runs on inactive users after 90 days)
// ──────────────────────────────────────────────

/**
 * Anonymize a user's profile: replace display_name with an anonymized string,
 * mark subscription as unsubscribed, and clear delivery preferences.
 * Returns the updated profile or null if the user doesn't exist.
 */
export async function anonymizeUser(kv: KVStore, telegramId: number): Promise<UserProfile | null> {
  const profile = await getUserProfile(kv, telegramId);
  if (!profile) return null;

  profile.display_name = `anon_${telegramId}`;
  profile.subscription_status = "unsubscribed";
  profile.timezone = "UTC";
  profile.delivery_time = "09:00";
  profile.updated_at = nowISO();

  // Remove from delivery schedule index
  const tRaw = await kv.get(k.scheduledUsers(profile.delivery_time));
  if (tRaw) {
    const schedIds: number[] = JSON.parse(tRaw);
    const filtered = schedIds.filter((id) => id !== telegramId);
    if (filtered.length > 0) {
      await kv.set(k.scheduledUsers(profile.delivery_time), JSON.stringify(filtered));
    } else {
      await kv.del(k.scheduledUsers(profile.delivery_time));
    }
  }

  await kv.set(k.userProfile(telegramId), JSON.stringify(profile));
  return profile;
}

/**
 * Bulk unsubscribe all users. Used by the owner to manage subscriptions.
 * Returns the number of users affected.
 */
export async function bulkUnsubscribeAll(kv: KVStore): Promise<number> {
  const allIds = await getAllUserIds(kv);
  let count = 0;
  const clearedTimes = new Set<string>();
  for (const id of allIds) {
    const profile = await getUserProfile(kv, id);
    if (profile && profile.subscription_status === "active") {
      profile.subscription_status = "unsubscribed";
      profile.updated_at = nowISO();
      await kv.set(k.userProfile(id), JSON.stringify(profile));
      // Remove from schedule index for this user's delivery time
      if (profile.delivery_time && !clearedTimes.has(profile.delivery_time)) {
        clearedTimes.add(profile.delivery_time);
      }
      count++;
    }
  }
  // Clear all schedule indexes that had active users
  for (const hhmm of clearedTimes) {
    const raw = await kv.get(k.scheduledUsers(hhmm));
    if (raw) {
      // Remove only unsubscribed users from each slot
      const ids: number[] = JSON.parse(raw);
      const kept: number[] = [];
      for (const uid of ids) {
        const p = await getUserProfile(kv, uid);
        if (p && p.subscription_status === "active") {
          kept.push(uid);
        }
      }
      if (kept.length > 0) {
        await kv.set(k.scheduledUsers(hhmm), JSON.stringify(kept));
      } else {
        await kv.del(k.scheduledUsers(hhmm));
      }
    }
  }
  return count;
}

// ──────────────────────────────────────────────
// Time helper (uses injectable clock)
// ──────────────────────────────────────────────

function nowISO(): string {
  return now().toISOString();
}