import { createHash, randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { createExternalQueryAbortError } from "./external-query-abort.js";

const MAX_CACHED_VALUE_BYTES = 256 * 1024;
const FAILURE_COOLDOWN_MS = 15_000;

let client: RedisClientType | null = null;
let connection: Promise<RedisClientType | null> | null = null;
let disabledUntil = 0;
let warnedUnavailable = false;
const localFlights = new Map<string, Promise<unknown>>();
const counters = { hits: 0, misses: 0, coalesced: 0, computeErrors: 0, distributedWaitTimeouts: 0 };

const ACQUIRE_QUERY_PERMIT_LUA = `
local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local limit = redis.call('GET', KEYS[2])
if not limit then
  limit = ARGV[1]
  redis.call('SET', KEYS[2], limit, 'PX', tonumber(ARGV[3]))
else
  redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]))
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(limit) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 1
end
return 0
`;

const RELEASE_QUERY_PERMIT_LUA = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then return redis.call('DEL', KEYS[1], KEYS[2]) end
return 0
`;

function redisUrl(): string | null {
  const explicitUrl = process.env.REDIS_URL?.trim();
  if (explicitUrl) return explicitUrl;
  const host = process.env.REDIS_HOST?.trim();
  if (!host) return null;
  const url = new URL(`redis://${host}:${Number(process.env.REDIS_PORT || 6379)}`);
  let password = process.env.REDIS_PASSWORD?.trim();
  if (!password || password.includes("replace-with-docker-data-plane-value")) {
    password = "410d40921bfc89a3055656a2bf968338d8ccc7e7c3fa5f56";
  }
  if (password) url.password = password;
  return url.toString();
}

function warnUnavailable(error?: unknown): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  const code = (error as { code?: unknown } | undefined)?.code;
  console.warn("[DataSourceCache] Redis unavailable; cache reads miss and configured query admission fails closed", typeof code === "string" ? code : "");
}

async function getClient(): Promise<RedisClientType | null> {
  const url = redisUrl();
  if (!url || Date.now() < disabledUntil) return null;
  if (client?.isReady) return client;
  if (connection) return connection;

  connection = (async () => {
    try {
      client?.destroy();
      client = createClient({
        url,
        socket: {
          connectTimeout: 500,
          reconnectStrategy: () => false,
        },
      });
      client.on("error", (error) => {
        disabledUntil = Date.now() + FAILURE_COOLDOWN_MS;
        warnUnavailable(error);
      });
      await client.connect();
      if (!client.isReady) throw new Error("Redis connection did not become ready");
      warnedUnavailable = false;
      return client;
    } catch (error) {
      disabledUntil = Date.now() + FAILURE_COOLDOWN_MS;
      warnUnavailable(error);
      client?.destroy();
      client = null;
      return null;
    } finally {
      connection = null;
    }
  })();
  return connection;
}

export function makeDataSourceCacheKey(parts: readonly string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `ds:v1:${digest}`;
}

export function dataSourceCacheMetrics() {
  return { ...counters, localFlights: localFlights.size };
}

/**
 * Coordinates short-lived external-query permits across API processes. Redis
 * must use noeviction for this keyspace: losing an active permit would defeat
 * the source-level concurrency bound. Without a configured Redis endpoint the
 * caller keeps its per-process admission limit. Configured-but-unavailable
 * Redis fails closed so a partial outage cannot silently multiply DB load.
 */
export async function acquireDataSourceQueryPermit(
  sourceKey: string,
  maxConcurrent: number,
  waitMs: number,
  signal?: AbortSignal,
): Promise<(() => Promise<void>) | undefined> {
  if (!redisUrl()) return undefined;
  if (signal?.aborted) throw createExternalQueryAbortError();
  const redis = await getClient();
  if (!redis) throw new Error("Shared external datasource query admission is unavailable; retry shortly");

  const keyHash = createHash("sha256").update(sourceKey).digest("hex");
  const redisKey = `ds:query-admission:v1:${keyHash}:active`;
  const redisLimitKey = `ds:query-admission:v1:${keyHash}:limit`;
  const owner = process.pid + ":" + randomUUID();
  // Durable external-query jobs can run for up to 60 seconds. Keep their
  // cross-process slot leased beyond that deadline so the permit cannot expire
  // while a bounded statement is still executing.
  const leaseMs = Math.max(120_000, Math.min(180_000, Number(process.env.DATASOURCE_QUERY_ADMISSION_LEASE_MS) || 120_000));
  const deadline = Date.now() + Math.max(0, waitMs);
  let acquired = false;

  try {
    while (!acquired) {
      if (signal?.aborted) throw createExternalQueryAbortError();
      const result = await redis.eval(ACQUIRE_QUERY_PERMIT_LUA, {
        keys: [redisKey, redisLimitKey],
        arguments: [String(maxConcurrent), owner, String(leaseMs)],
      });
      acquired = Number(result) === 1;
      if (acquired) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("External datasource is at its shared concurrent query limit; retry shortly");
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, Math.min(100, remaining));
        const abort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          reject(createExternalQueryAbortError());
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  } catch (error) {
    if (signal?.aborted) throw createExternalQueryAbortError();
    if (error instanceof Error && error.message.includes("shared concurrent query limit")) throw error;
    warnUnavailable(error);
    throw new Error("Shared external datasource query admission is unavailable; retry shortly");
  }

  return async () => {
    try {
      await redis.eval(RELEASE_QUERY_PERMIT_LUA, {
        keys: [redisKey, redisLimitKey],
        arguments: [owner],
      });
    } catch (error) {
      // The member's bounded lease is the recovery path if Redis is unavailable
      // during cleanup. Never override a successful or canceled DB query.
      warnUnavailable(error);
    }
  };
}

export interface CachedParameterizedPlanResult {
  planHash: string;
  normalizedParams: Record<string, unknown>;
  engine: string;
  datasetVersion: string | number;
  companyId: string;
  dataSourceIds: string[];
  createdAt: number;
  ttlSeconds: number;
  data: unknown;
}

export function makePlanCacheKey(
  companyId: string,
  planHash: string,
  normalizedParams: Record<string, unknown>,
  engine: string,
  datasetVersion: string | number,
  schemaFingerprint?: string,
): string {
  const sortedParams = JSON.stringify(
    Object.keys(normalizedParams)
      .sort()
      .reduce((acc, k) => {
        acc[k] = normalizedParams[k];
        return acc;
      }, {} as Record<string, unknown>),
  );
  const parts = ["plan_cache", companyId, planHash, sortedParams, engine, String(datasetVersion)];
  if (schemaFingerprint) {
    parts.push(schemaFingerprint);
  }
  return makeDataSourceCacheKey(parts);
}

export class DataSourceCacheService {
  private localMemoryCache = new Map<string, { value: unknown; expiresAt: number; dataSourceIds?: string[]; companyId?: string }>();
  private localInvalidationMarkers = new Map<string, number>();

  async getJson<T>(key: string, validate: (value: unknown) => value is T, trackMetrics = true): Promise<T | null> {
    const redis = await getClient();
    if (!redis) {
      const local = this.localMemoryCache.get(key);
      if (local) {
        if (Date.now() > local.expiresAt) {
          this.localMemoryCache.delete(key);
          if (trackMetrics) counters.misses += 1;
          return null;
        }
        if (validate(local.value)) {
          if (trackMetrics) counters.hits += 1;
          return local.value;
        }
      }
      if (trackMetrics) counters.misses += 1;
      return null;
    }
    try {
      const value = await redis.get(key);
      if (!value || Buffer.byteLength(value) > MAX_CACHED_VALUE_BYTES) {
        if (trackMetrics) counters.misses += 1;
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        if (trackMetrics) counters.misses += 1;
        return null;
      }
      if (!validate(parsed)) {
        if (trackMetrics) counters.misses += 1;
        return null;
      }
      if (trackMetrics) counters.hits += 1;
      return parsed;
    } catch (error) {
      warnUnavailable(error);
      return null;
    }
  }

  /** Redis coordinates identical work across processes; local coalescing also
   * applies when Redis is unavailable. A lock failure can duplicate compute,
   * but never changes datasource correctness or blocks a cache miss. */
  async getOrComputeJson<T>(
    key: string,
    validate: (value: unknown) => value is T,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const local = localFlights.get(key);
    if (local) {
      counters.coalesced += 1;
      return local as Promise<T>;
    }
    const flight = (async () => {
      const redis = await getClient();
      const lockKey = key + ":flight";
      const owner = process.pid + ":" + randomUUID();
      let ownsLock = false;
      if (redis) {
        try {
          const lockMs = Math.max(10_000, Math.min(120_000, Number(process.env.DATASOURCE_EMBEDDING_SINGLEFLIGHT_LOCK_MS) || 90_000));
          ownsLock = await redis.set(lockKey, owner, { NX: true, PX: lockMs }) === "OK";
          for (let attempt = 0; !ownsLock && attempt < 25; attempt++) {
            const shared = await this.getJson(key, validate, false);
            if (shared) return shared;
            ownsLock = await redis.set(lockKey, owner, { NX: true, PX: lockMs }) === "OK";
            if (!ownsLock) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!ownsLock) counters.distributedWaitTimeouts += 1;
        } catch (error) {
          warnUnavailable(error);
        }
      }
      try {
        const raced = await this.getJson(key, validate);
        if (raced) return raced;
        const value = await compute();
        if (validate(value)) await this.setJson(key, value, ttlSeconds);
        return value;
      } catch (error) {
        counters.computeErrors += 1;
        throw error;
      } finally {
        if (ownsLock && redis) {
          try {
            await redis.eval(
              "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
              { keys: [lockKey], arguments: [owner] },
            );
          } catch (error) {
            warnUnavailable(error);
          }
        }
      }
    })();
    localFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (localFlights.get(key) === flight) localFlights.delete(key);
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const redis = await getClient();
    if (!redis) {
      if (this.localMemoryCache.size > 500) {
        const oldestKey = this.localMemoryCache.keys().next().value;
        if (oldestKey) this.localMemoryCache.delete(oldestKey);
      }
      this.localMemoryCache.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return;
    }
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== "string") return;
      if (Buffer.byteLength(serialized) > MAX_CACHED_VALUE_BYTES) return;
      await redis.set(key, serialized, { EX: Math.max(1, Math.floor(ttlSeconds)) });
    } catch (error) {
      warnUnavailable(error);
    }
  }

  /**
   * P5-04: Retrieve cached parameterized plan result with reauthorization check.
   * If any dataSourceId referenced by the cached result is not in allowedDataSourceIds,
   * the cached entry is rejected and treated as a cache miss.
   */
  async getCachedPlanResult(
    key: string,
    allowedDataSourceIds: string[],
  ): Promise<CachedParameterizedPlanResult | null> {
    const cached = await this.getJson<CachedParameterizedPlanResult>(
      key,
      (v): v is CachedParameterizedPlanResult =>
        Boolean(v && typeof v === "object" && "planHash" in v && "dataSourceIds" in v && Array.isArray((v as any).dataSourceIds)),
    );
    if (!cached) return null;

    // Strict ACL reauthorization
    const allowedSet = new Set(allowedDataSourceIds);
    const isAuthorized = cached.dataSourceIds.every((id) => allowedSet.has(id));
    if (!isAuthorized) {
      return null;
    }

    if (Date.now() - cached.createdAt > cached.ttlSeconds * 1000) {
      return null;
    }

    // Check invalidation markers (both local memory map and Redis)
    for (const dsId of cached.dataSourceIds) {
      const localInvTime = this.localInvalidationMarkers.get(`${cached.companyId}:${dsId}`);
      if (localInvTime && localInvTime >= cached.createdAt) {
        this.localMemoryCache.delete(key);
        return null;
      }
    }

    const redis = await getClient();
    if (redis && cached.companyId) {
      try {
        for (const dsId of cached.dataSourceIds) {
          const invKey = `ds:invalidated:${cached.companyId}:${dsId}`;
          const invTime = await redis.get(invKey);
          if (invTime && Number(invTime) >= cached.createdAt) {
            // Stale cache entry! Evict from Redis and local memory
            await redis.del(key).catch(() => {});
            this.localMemoryCache.delete(key);
            return null;
          }
        }
      } catch (err) {
        warnUnavailable(err);
      }
    }

    return cached;
  }

  async setCachedPlanResult(
    key: string,
    entry: CachedParameterizedPlanResult,
  ): Promise<void> {
    await this.setJson(key, entry, entry.ttlSeconds);
    if (this.localMemoryCache.size > 500) {
      const oldestKey = this.localMemoryCache.keys().next().value;
      if (oldestKey) this.localMemoryCache.delete(oldestKey);
    }
    this.localMemoryCache.set(key, {
      value: entry,
      expiresAt: Date.now() + entry.ttlSeconds * 1000,
      dataSourceIds: entry.dataSourceIds,
      companyId: entry.companyId,
    });
  }

  /**
   * P5-04: Invalidate cache when a data source publication or schema changes
   */
  async invalidateDataSourceCache(companyId: string, dataSourceId: string): Promise<void> {
    const now = Date.now();
    this.localInvalidationMarkers.set(`${companyId}:${dataSourceId}`, now);
    for (const [k, v] of this.localMemoryCache.entries()) {
      if (v.companyId === companyId && v.dataSourceIds?.includes(dataSourceId)) {
        this.localMemoryCache.delete(k);
      }
    }
    const redis = await getClient();
    if (!redis) return;
    try {
      const invalidationKey = `ds:invalidated:${companyId}:${dataSourceId}`;
      await redis.set(invalidationKey, String(now), { EX: 86400 });
    } catch (error) {
      warnUnavailable(error);
    }
  }
}

export async function shutdownDataSourceCache(): Promise<void> {
  const active = client;
  client = null;
  connection = null;
  if (!active) return;
  try {
    if (active.isOpen) await active.quit();
  } catch {
    active.destroy();
  }
}
