import Redis from "ioredis";
import { RedisLimiterInitError } from "./errors";
import type { RateLimitStore } from "./store";
import { RedisStoreOptionsSchema, type CheckResult, type RedisStoreOptionsInput } from "./types";

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

export type RedisStoreLogger = {
  warn(message: string, error?: unknown): void;
};

type RedisStoreClient = {
  script(subcommand: "LOAD", script: string): Promise<unknown>;
  evalsha(sha: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown>;
  time(): Promise<Array<string | number>>;
};

export class RedisStore implements RateLimitStore {
  private readonly redis: RedisStoreClient;
  private readonly burst: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private readonly ttlMs: number;
  private readonly logger: RedisStoreLogger;
  private scriptSha: string | null = null;

  constructor(options: RedisStoreOptionsInput, logger: RedisStoreLogger = console) {
    try {
      const config = RedisStoreOptionsSchema.parse(options);

      this.redis = createRedisClient(config.redisUrl);
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

  async check(rawKey: string): Promise<CheckResult> {
    try {
      const key = `rl:${rawKey}`;
      const now = await this.getNow();
      const result = await this.runScript(key, now);

      return parseScriptResult(result, this.burst);
    } catch (error) {
      this.logger.warn("Redis rate limiter failed open. Allowing request.", error);
      return this.allowedFallback();
    }
  }

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

  private async getNow(): Promise<number> {
    try {
      const [seconds, microseconds] = await this.redis.time();
      const secondsNumber = Number(seconds);
      const microsecondsNumber = Number(microseconds);

      if (Number.isFinite(secondsNumber) && Number.isFinite(microsecondsNumber)) {
        return secondsNumber * 1000 + Math.floor(microsecondsNumber / 1000);
      }
    } catch {
    }

    return Date.now();
  }

  private allowedFallback(): CheckResult {
    return {
      allowed: true,
      limit: this.burst,
      remaining: this.burst,
      resetTime: Date.now() + this.refillInterval,
      retryAfter: 0,
    };
  }
}

function parseScriptResult(result: unknown, limit: number): CheckResult {
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
    limit,
    remaining: Math.max(0, remaining),
    resetTime,
    retryAfter,
  };
}

function createRedisClient(redisUrl: string): RedisStoreClient {
  return new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}

function isNoScriptError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("NOSCRIPT");
}
