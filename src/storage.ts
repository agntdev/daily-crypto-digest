/**
 * Persistent data store for durable domain data.
 *
 * Wraps the toolkit's Redis storage (or an in-memory fallback for dev/test) with
 * typed collections, index-aware lookups — NEVER enumerates the keyspace.
 *
 * Indices (explicit pointers, never keyspace scan):
 *   - `idx:user:all`             → string[] of telegram_ids
 *   - `idx:user:subscribed`      → string[] of subscribed telegram_ids
 *   - `idx:digest:next`          → string[] of digest_item ids
 *   - `idx:log:all`              → string[] of log entry keys (capped at 1000)
 *   - `idx:source:priorities`    → string[] of source name priorities
 */

import type { StorageAdapter } from "grammy";
import { now } from "./clock.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UserProfile {
  telegram_id: number;
  display_name: string;
  timezone: string;
  delivery_time: string; // "HH:MM" in 24h format
  subscription_status: "active" | "paused" | "unsubscribed";
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

export interface DigestItem {
  id: string;
  headline: string;
  summary_text: string;
  source_name: string;
  source_url: string;
  published_at: string;
  topic_tags: string[];
}

export interface DeliverySchedule {
  user_id: number;
  local_send_time: string; // "HH:MM" in 24h
  next_scheduled_send: string | null; // ISO 8601 or null
}

export interface ActivityLog {
  event_type: string;
  timestamp: string; // ISO 8601
  user_id: number | null;
  details: string;
}

// ── Store class ────────────────────────────────────────────────────────────────

const PREFIX = "app:";

export class PersistentStore {
  constructor(private readonly storage: StorageAdapter<unknown>) {}

  private k(key: string): string {
    return PREFIX + key;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    return this.storage.read(this.k(key)) as Promise<T | undefined>;
  }

  private async write<T>(key: string, value: T): Promise<void> {
    await this.storage.write(this.k(key), value);
  }

  private async del(key: string): Promise<void> {
    await this.storage.delete(this.k(key));
  }

  // ---- UserProfile ────────────────────────────────────────────────────────────

  async getUser(telegramId: number): Promise<UserProfile | undefined> {
    return this.read<UserProfile>(`user:${telegramId}`);
  }

  async saveUser(profile: UserProfile): Promise<void> {
    await this.write(`user:${profile.telegram_id}`, profile);
    // Maintain "all users" index
    const allIds = (await this.getIndex<string[]>("user:all")) ?? [];
    if (!allIds.includes(String(profile.telegram_id))) {
      allIds.push(String(profile.telegram_id));
      await this.setIndex("user:all", allIds);
    }
    // Maintain "subscribed" index
    if (profile.subscription_status === "active") {
      const subIds = (await this.getIndex<string[]>("user:subscribed")) ?? [];
      if (!subIds.includes(String(profile.telegram_id))) {
        subIds.push(String(profile.telegram_id));
        await this.setIndex("user:subscribed", subIds);
      }
    } else {
      const subIds = (await this.getIndex<string[]>("user:subscribed")) ?? [];
      const filtered = subIds.filter((id) => id !== String(profile.telegram_id));
      if (filtered.length !== subIds.length) {
        await this.setIndex("user:subscribed", filtered);
      }
    }
  }

  async getAllUserIds(): Promise<number[]> {
    const ids = (await this.getIndex<string[]>("user:all")) ?? [];
    return ids.map(Number).filter((n) => !isNaN(n));
  }

  async getSubscribedUserIds(): Promise<number[]> {
    const ids = (await this.getIndex<string[]>("user:subscribed")) ?? [];
    return ids.map(Number).filter((n) => !isNaN(n));
  }

  // ---- DigestItem ─────────────────────────────────────────────────────────────

  async getDigestItem(id: string): Promise<DigestItem | undefined> {
    return this.read<DigestItem>(`digest:${id}`);
  }

  async saveDigestItem(item: DigestItem): Promise<void> {
    await this.write(`digest:${item.id}`, item);
    const ids = (await this.getIndex<string[]>("digest:next")) ?? [];
    if (!ids.includes(item.id)) {
      ids.push(item.id);
      await this.setIndex("digest:next", ids);
    }
  }

  async getNextDigestIds(): Promise<string[]> {
    return (await this.getIndex<string[]>("digest:next")) ?? [];
  }

  async clearDigestNextIndex(): Promise<void> {
    await this.setIndex("digest:next", []);
  }

  // ---- DeliverySchedule ───────────────────────────────────────────────────────

  async getSchedule(userId: number): Promise<DeliverySchedule | undefined> {
    return this.read<DeliverySchedule>(`schedule:${userId}`);
  }

  async saveSchedule(schedule: DeliverySchedule): Promise<void> {
    await this.write(`schedule:${schedule.user_id}`, schedule);
  }

  async deleteSchedule(userId: number): Promise<void> {
    await this.del(`schedule:${userId}`);
  }

  // ---- ActivityLog ────────────────────────────────────────────────────────────

  async logEvent(
    event_type: string,
    userId: number | null,
    details: string,
  ): Promise<void> {
    const n = now();
    const id = `log:${n.getTime().toString(36)}:${Math.random().toString(36).slice(2, 6)}`;
    const entry: ActivityLog = {
      event_type,
      timestamp: n.toISOString(),
      user_id: userId,
      details,
    };
    await this.write(id, entry);
    const logIds = (await this.getIndex<string[]>("log:all")) ?? [];
    logIds.push(id);
    while (logIds.length > 1000) {
      const old = logIds.shift();
      if (old) await this.del(old);
    }
    await this.setIndex("log:all", logIds);
  }

  async getRecentLogs(limit = 50): Promise<ActivityLog[]> {
    const logIds = (await this.getIndex<string[]>("log:all")) ?? [];
    const recent = logIds.slice(-limit);
    const entries: ActivityLog[] = [];
    for (const id of recent) {
      const entry = await this.read<ActivityLog>(id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  // ---- Admin chat ─────────────────────────────────────────────────────────────

  async getAdminChatId(): Promise<number | undefined> {
    return this.read<number>("admin:chat_id");
  }

  async setAdminChatId(chatId: number): Promise<void> {
    await this.write("admin:chat_id", chatId);
  }

  // ---- News source config (owner controls) ───────────────────────────────────

  async getNewsSourcePriorities(): Promise<string[]> {
    return (await this.getIndex<string[]>("source:priorities")) ?? [
      "CoinDesk",
      "CoinTelegraph",
      "Decrypt",
      "The Block",
      "CryptoSlate",
    ];
  }

  async setNewsSourcePriorities(priorities: string[]): Promise<void> {
    await this.setIndex("source:priorities", priorities);
  }

  async getSummaryLengthLimit(): Promise<number> {
    const val = await this.read<number>("config:summary_length");
    return val ?? 200;
  }

  async setSummaryLengthLimit(limit: number): Promise<void> {
    await this.write("config:summary_length", limit);
  }

  // ---- Index helpers (no keyspace scan) ───────────────────────────────────────

  private async getIndex<T>(name: string): Promise<T | undefined> {
    return this.read<T>(`idx:${name}`);
  }

  private async setIndex<T>(name: string, value: T): Promise<void> {
    await this.write(`idx:${name}`, value);
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────────

let _store: PersistentStore | null = null;

/**
 * initStore creates or returns the singleton persistent store.
 * Test-only: call resetStore() between test suites, or call initStore() with
 * an explicit adapter to override.
 */
export function initStore(
  adapter?: StorageAdapter<unknown>,
): PersistentStore {
  if (_store) return _store;
  _store = new PersistentStore(adapter ?? new MapStorage());
  return _store;
}

/** Reset the singleton (test-only hook). */
export function resetStore(): void {
  _store = null;
}

/** Get the singleton store (throws if not yet initialized). */
export function getStore(): PersistentStore {
  if (!_store) throw new Error("PersistentStore not initialized");
  return _store;
}

// ── In-memory MapStorage (dev/test fallback) ───────────────────────────────────

class MapStorage implements StorageAdapter<unknown> {
  private store = new Map<string, unknown>();

  read(key: string): unknown | undefined {
    return this.store.get(key);
  }
  write(key: string, value: unknown): void {
    this.store.set(key, value);
  }
  delete(key: string): void {
    this.store.delete(key);
  }
  has(key: string): boolean {
    return this.store.has(key);
  }
  readAllKeys(): string[] {
    return [...this.store.keys()];
  }
}