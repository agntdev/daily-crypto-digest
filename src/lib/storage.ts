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
  // Indexes (explicit, never scanned)
  allUsers: () => `${PREFIX}idx:users`,
  allDigestItems: () => `${PREFIX}idx:digest_items`,
  scheduledUsers: (hhmm: string) => `${PREFIX}idx:sched:${hhmm}`,
  userDeliveries: (telegramId: number) => `${PREFIX}idx:deliveries:${telegramId}`,
  adminChat: () => `${PREFIX}admin:chat`,
  adminErrors: () => `${PREFIX}idx:admin_errors`,
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

export async function saveUserProfile(kv: KVStore, profile: UserProfile): Promise<void> {
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
  const eventId = `${Date.now()}-${_logCounter}`;
  await kv.set(k.activityLog(eventId), JSON.stringify(entry));

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
// Time helper
// ──────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}