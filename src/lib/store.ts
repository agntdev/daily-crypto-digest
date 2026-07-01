import { createRequire } from "node:module";

// A minimal Redis client surface for durable domain data.
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<number>;
  srem(key: string, ...members: string[]): Promise<number>;
  smembers(key: string): Promise<string[]>;
  scard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  hkeys(key: string): Promise<string[]>;
  exists(key: string): Promise<number>;
  incr(key: string): Promise<number>;
}

function requireRedis(): any {
  const require = createRequire(import.meta.url);
  const ioredis: any = require("ioredis");
  return ioredis.default ?? ioredis.Redis ?? ioredis;
}

let _redis: RedisLike | undefined;

function getRedis(): RedisLike | undefined {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return undefined;
  const Redis = requireRedis();
  const client = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  _redis = client as unknown as RedisLike;
  return _redis;
}

/**
 * Persistent store backed by Redis for durable domain data.
 * Uses hash keys for records and sets for indices — never scans the keyspace.
 * Falls back to an in-memory store when REDIS_URL is unset (test/dev).
 */
export class PersistentStore {
  private redis: RedisLike | undefined;
  private fallback = new Map<string, string>();
  private fallbackSets = new Map<string, Set<string>>();
  private fallbackHashes = new Map<string, Map<string, string>>();

  constructor() {
    this.redis = getRedis();
  }

  // ---- Key-value (simple records, JSON-serialized) ----

  private kvKey(key: string): string {
    return `kv:${key}`;
  }

  async kvGet<T>(key: string): Promise<T | undefined> {
    const raw = this.redis
      ? await this.redis.get(this.kvKey(key))
      : (this.fallback.get(key) ?? null);
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async kvSet<T>(key: string, value: T): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(this.kvKey(key), raw);
    } else {
      this.fallback.set(key, raw);
    }
  }

  async kvDelete(key: string): Promise<void> {
    if (this.redis) {
      await this.redis.del(this.kvKey(key));
    } else {
      this.fallback.delete(key);
    }
  }

  async kvExists(key: string): Promise<boolean> {
    if (this.redis) {
      return (await this.redis.exists(this.kvKey(key))) === 1;
    }
    return this.fallback.has(key);
  }

  // ---- Hash (record fields) ----

  private hashKey(key: string): string {
    return `hash:${key}`;
  }

  async hashGet(key: string, field: string): Promise<string | undefined> {
    if (this.redis) {
      const v = await this.redis.hget(this.hashKey(key), field);
      return v ?? undefined;
    }
    return this.fallbackHashes.get(key)?.get(field);
  }

  async hashSet(key: string, field: string, value: string): Promise<void> {
    if (this.redis) {
      await this.redis.hset(this.hashKey(key), field, value);
    } else {
      let m = this.fallbackHashes.get(key);
      if (!m) {
        m = new Map();
        this.fallbackHashes.set(key, m);
      }
      m.set(field, value);
    }
  }

  async hashGetAll(key: string): Promise<Record<string, string>> {
    if (this.redis) {
      return this.redis.hgetall(this.hashKey(key));
    }
    const m = this.fallbackHashes.get(key);
    if (!m) return {};
    return Object.fromEntries(m);
  }

  async hashDelete(key: string, ...fields: string[]): Promise<void> {
    if (this.redis) {
      await this.redis.hdel(this.hashKey(key), ...fields);
    } else {
      const m = this.fallbackHashes.get(key);
      if (m) {
        for (const f of fields) m.delete(f);
      }
    }
  }

  async hashFields(key: string): Promise<string[]> {
    if (this.redis) {
      return this.redis.hkeys(this.hashKey(key));
    }
    return [...(this.fallbackHashes.get(key)?.keys() ?? [])];
  }

  // ---- Sets (indices) ----

  private setKey(key: string): string {
    return `set:${key}`;
  }

  async setAdd(key: string, ...members: string[]): Promise<void> {
    if (this.redis) {
      await this.redis.sadd(this.setKey(key), ...members);
    } else {
      let s = this.fallbackSets.get(key);
      if (!s) {
        s = new Set();
        this.fallbackSets.set(key, s);
      }
      for (const m of members) s.add(m);
    }
  }

  async setRemove(key: string, ...members: string[]): Promise<void> {
    if (this.redis) {
      await this.redis.srem(this.setKey(key), ...members);
    } else {
      const s = this.fallbackSets.get(key);
      if (s) {
        for (const m of members) s.delete(m);
      }
    }
  }

  async setMembers(key: string): Promise<string[]> {
    if (this.redis) {
      return this.redis.smembers(this.setKey(key));
    }
    return [...(this.fallbackSets.get(key) ?? new Set())];
  }

  async setCard(key: string): Promise<number> {
    if (this.redis) {
      return this.redis.scard(this.setKey(key));
    }
    return this.fallbackSets.get(key)?.size ?? 0;
  }

  // ---- Counters ----

  private counterKey(key: string): string {
    return `ctr:${key}`;
  }

  async incr(key: string): Promise<number> {
    if (this.redis) {
      return this.redis.incr(this.counterKey(key));
    }
    const current = Number(this.fallback.get(`ctr:${key}`) ?? "0") + 1;
    this.fallback.set(`ctr:${key}`, String(current));
    return current;
  }

  // ---- Expiry ----

  async expire(key: string, seconds: number): Promise<void> {
    if (this.redis) {
      await this.redis.expire(this.kvKey(key), seconds);
    }
    // no-op in fallback
  }

  // ---- Clear (test-only) ----

  _clear(): void {
    this.fallback.clear();
    this.fallbackSets.clear();
    this.fallbackHashes.clear();
  }
}

/** Singleton store instance. */
let _store: PersistentStore | undefined;

export function getStore(): PersistentStore {
  if (!_store) _store = new PersistentStore();
  return _store;
}

/** Reset the singleton (test-only). */
export function _resetStore(): void {
  _store = undefined;
}
