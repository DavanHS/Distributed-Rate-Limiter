import Redis from "ioredis";
import { RedisLimiterInitError } from "./errors";
import { normalizeKey } from "./key-resolver";
import type { RateLimitStore } from "./store";
import { RateLimitOptionsSchema, type CheckResult, type RateLimitOptionsInput } from "./types";

/**
 * Lua script that implements the token bucket algorithm atomically in Redis.
 *
 * Runs entirely server-side to prevent race conditions between concurrent
 * requests. The script:
 * 1. Reads current token count and last refill time from a Redis hash.
 * 2. Initializes a new bucket at full capacity if the key doesn't exist.
 * 3. Refills tokens based on elapsed time since last access.
 * 4. Consumes one token if available.
 * 5. Persists updated state with a TTL (2× refill interval).
 *
 * Returns: `[allowed, remaining, resetTime, retryAfter]`
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local refillInterval = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local tokens = tonumber(redis.call("HGET", key, "tokens"))
local lastRefill = tonumber(redis.call("HGET", key, "lastRefill"))

if tokens == nil or lastRefill == nil then
  tokens = burst
  lastRefill = now
else
  local elapsed = now - lastRefill
  local intervals = math.floor(elapsed / refillInterval)

  if intervals > 0 then
    tokens = math.min(burst, tokens + (intervals * refillRate))
    lastRefill = lastRefill + (intervals * refillInterval)
  end
end

local allowed = 0
local remaining = tokens

if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
  remaining = tokens
end

redis.call("HSET", key, "tokens", tokens, "lastRefill", lastRefill)
redis.call("PEXPIRE", key, ttl)

local resetTime = lastRefill + refillInterval
local retryAfter = resetTime

if allowed == 1 then
  retryAfter = 0
end

return { allowed, math.max(0, remaining), resetTime, retryAfter }
`;

/**
 * Logger interface used by `RedisStore` for warning messages.
 *
 * Defaults to `console` but can be replaced with any logger
 * that has a `warn` method.
 */
export type RedisStoreLogger = {
  warn(message: string, error?: unknown): void;
};

/**
 * Minimal interface for a Redis client used by `RedisStore`.
 *
 * Only the methods needed for rate limiting are exposed. This allows
 * you to inject a real ioredis client, a mock for testing, or any
 * compatible client without coupling to a specific library.
 *
 * Required methods:
 * - `script("LOAD", script)` — loads a Lua script and returns its SHA.
 * - `evalsha(sha, numkeys, ...args)` — executes a loaded script by SHA.
 * - `eval(script, numkeys, ...args)` — executes a script directly (fallback).
 * - `time()` — returns the Redis server's current time.
 */
export type RedisStoreClient = {
  script(subcommand: "LOAD", script: string): Promise<unknown>;
  evalsha(sha: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  time(): Promise<Array<string | number>>;
};

/**
 * A distributed rate limit store backed by Redis.
 *
 * Uses a Lua script for atomic token bucket operations, ensuring correct
 * behavior even under high concurrency across multiple server instances.
 *
 * Script execution strategy:
 * 1. `SCRIPT LOAD` on first use — caches the SHA hash.
 * 2. `EVALSHA` for subsequent calls — fast, sends only the SHA.
 * 3. `EVAL` fallback if Redis flushes scripts (`NOSCRIPT` error).
 *
 * Timestamps use the Redis server clock (`TIME` command) for consistency
 * across distributed instances, falling back to `Date.now()` if unavailable.
 *
 * Keys are stored as Redis hashes at `rl:<normalizedKey>` with fields
 * `tokens` and `lastRefill`. TTL is set to 2× the refill interval so
 * stale entries are automatically cleaned up.
 *
 * Runtime errors fail open — the request is allowed and a warning is logged.
 * Init errors (missing URL, bad config) throw `RedisLimiterInitError`.
 *
 * @example
 * ```ts
 * import { RedisStore } from "@davanhs/rate-limiter";
 *
 * const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
 * const result = await store.check("192.168.1.1");
 * console.log(result.allowed); // true
 * ```
 *
 * @example
 * ```ts
 * // Inject your own Redis client
 * import Redis from "ioredis";
 * const client = new Redis("redis://localhost:6379");
 * const store = new RedisStore({ redisUrl: "redis://localhost:6379" }, client);
 * ```
 */
export class RedisStore implements RateLimitStore {
  private readonly redis: RedisStoreClient;
  private readonly burst: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private readonly ttlMs: number;
  private readonly logger: RedisStoreLogger;
  private scriptSha: string | null = null;

  /**
   * Creates a new Redis-backed rate limit store.
   *
   * @param options - Rate limit configuration. Must include `redisUrl` unless a client is injected.
   * @param redis - Optional Redis client. If omitted, one is created from `redisUrl`.
   * @param logger - Logger for warning messages. Defaults to `console`.
   * @throws {RedisLimiterInitError} If `redisUrl` is missing and no client is injected, or if config is invalid.
   */
  constructor(
    options: RateLimitOptionsInput,
    redis?: RedisStoreClient,
    logger: RedisStoreLogger = console,
  ) {
    try {
      const config = RateLimitOptionsSchema.parse(options);

      if (!config.redisUrl && !redis) {
        throw new RedisLimiterInitError("RedisStore requires redisUrl.");
      }

      this.redis =
        redis ??
        new Redis(config.redisUrl!, {
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        });
      this.burst = config.burst;
      this.refillRate = config.refillRate;
      this.refillInterval = config.refillInterval;
      this.ttlMs = config.refillInterval * 2;
      this.logger = logger;
    } catch (error) {
      if (error instanceof RedisLimiterInitError) {
        throw error;
      }

      throw new RedisLimiterInitError(
        error instanceof Error ? error.message : "Failed to initialize RedisStore.",
      );
    }
  }

  /**
   * Checks whether a key has tokens remaining and consumes one if allowed.
   *
   * Executes the token bucket Lua script atomically in Redis. Uses the
   * Redis server clock for timestamps to ensure consistency across
   * distributed instances.
   *
   * @param rawKey - The raw rate limit key (e.g. IP address, user ID).
   * @returns A `CheckResult` indicating whether the request is allowed.
   */
  async check(rawKey: string): Promise<CheckResult> {
    try {
      const key = `rl:${normalizeKey(rawKey)}`;
      const now = await this.getNow();
      const result = await this.runScript(key, now);

      return parseScriptResult(result);
    } catch (error) {
      this.logger.warn("Redis rate limiter failed open. Allowing request.", error);
      return this.allowedFallback();
    }
  }

  /**
   * Executes the token bucket Lua script in Redis.
   *
   * Uses `EVALSHA` with a cached SHA for performance, falling back to
   * `EVAL` if the script is not found (e.g. after a Redis restart or
   * `SCRIPT FLUSH`).
   *
   * @param key - The normalized Redis key.
   * @param now - The current timestamp in milliseconds.
   * @returns The raw script result array.
   */
  private async runScript(key: string, now: number): Promise<unknown> {
    const args = [key, now, this.burst, this.refillRate, this.refillInterval, this.ttlMs];

    if (this.scriptSha === null) {
      this.scriptSha = String(await this.redis.script("LOAD", TOKEN_BUCKET_SCRIPT));
    }

    try {
      return await this.redis.evalsha(this.scriptSha, 1, ...args);
    } catch (error) {
      if (isNoScriptError(error)) {
        this.scriptSha = null;
        return this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, ...args);
      }

      throw error;
    }
  }

  /**
   * Gets the current timestamp from the Redis server.
   *
   * Uses the `TIME` command for server-clock consistency across
   * distributed instances. Falls back to `Date.now()` if the
   * command fails.
   *
   * @returns The current timestamp in milliseconds.
   */
  private async getNow(): Promise<number> {
    try {
      const [seconds, microseconds] = await this.redis.time();
      const secondsNumber = Number(seconds);
      const microsecondsNumber = Number(microseconds);

      if (Number.isFinite(secondsNumber) && Number.isFinite(microsecondsNumber)) {
        return secondsNumber * 1000 + Math.floor(microsecondsNumber / 1000);
      }
    } catch {
      // fall through to local clock
    }

    return Date.now();
  }

  /**
   * Returns a permissive `CheckResult` used when Redis fails at runtime.
   *
   * This implements the fail-open strategy — when Redis is unavailable,
   * requests are allowed through rather than blocked.
   *
   * @returns A `CheckResult` that always allows the request.
   */
  private allowedFallback(): CheckResult {
    return {
      allowed: true,
      remaining: this.burst,
      resetTime: Date.now() + this.refillInterval,
      retryAfter: 0,
    };
  }
}

/**
 * Parses the raw Lua script result into a typed `CheckResult`.
 *
 * Validates that the result is an array of 4 numbers and converts
 * the `allowed` field from Redis's integer (0/1) to a boolean.
 *
 * @param result - The raw result from the Lua script.
 * @returns A typed `CheckResult`.
 * @throws {Error} If the result format is invalid.
 */
function parseScriptResult(result: unknown): CheckResult {
  if (!Array.isArray(result) || result.length < 4) {
    throw new Error("Invalid Redis token bucket script result.");
  }

  const allowed = Number(result[0]);
  const remaining = Number(result[1]);
  const resetTime = Number(result[2]);
  const retryAfter = Number(result[3]);

  if (
    !Number.isFinite(allowed) ||
    !Number.isFinite(remaining) ||
    !Number.isFinite(resetTime) ||
    !Number.isFinite(retryAfter)
  ) {
    throw new Error("Invalid Redis token bucket script result.");
  }

  return {
    allowed: allowed === 1,
    remaining: Math.max(0, remaining),
    resetTime,
    retryAfter,
  };
}

/**
 * Checks whether an error is a Redis `NOSCRIPT` error.
 *
 * This occurs when a script SHA is no longer known to Redis
 * (e.g. after `SCRIPT FLUSH` or a Redis restart). The store
 * responds by falling back to `EVAL` with the full script.
 *
 * @param error - The error to check.
 * @returns `true` if the error is a `NOSCRIPT` error.
 */
function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}
