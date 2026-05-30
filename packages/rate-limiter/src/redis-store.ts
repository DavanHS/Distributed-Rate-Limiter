import { Redis } from 'ioredis';
import type { CheckResult, RateLimitStore, Logger, RedisStoreOptions } from './types.js';
import { RedisStoreOptionsSchema } from './types.js';

const LUA_SCRIPT = `
local key = KEYS[1]
local burst = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local refillInterval = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

local data = redis.call('HGETALL', key)
local tokens = burst
local lastRefill = now

if #data > 0 then
    for i = 1, #data, 2 do
        if data[i] == 'tokens' then tokens = tonumber(data[i+1]) end
        if data[i] == 'lastRefill' then lastRefill = tonumber(data[i+1]) end
    end
end

local elapsed = math.max(0, now - lastRefill)
local intervals = math.floor(elapsed / refillInterval)
if intervals > 0 then
    tokens = math.min(burst, tokens + (intervals * refillRate))
    lastRefill = lastRefill + (intervals * refillInterval)
end

local allowed = 0
local retryAfter = 0

if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
else
    local msToNextToken = refillInterval - (now - lastRefill)
    retryAfter = math.max(1, math.ceil(msToNextToken / 1000))
end

redis.call('HSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('PEXPIRE', key, refillInterval * 2)

return { allowed, tokens, retryAfter }
`;

export class RedisStore implements RateLimitStore {
  private redis: Redis;
  private readonly burst: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private readonly failOpen: boolean;
  private readonly ttl: number;
  private logger?: Logger;
  private scriptHash: string | null = null;
  private initPromise: Promise<void>;

  constructor(options: RedisStoreOptions, logger?: Logger) {
    const parsed = RedisStoreOptionsSchema.parse(options);
    this.burst = parsed.burst;
    this.refillRate = parsed.refillRate;
    this.refillInterval = parsed.refillInterval;
    this.failOpen = parsed.failOpen;
    this.ttl = this.refillInterval * 2;
    this.logger = logger;

    this.redis = new Redis(parsed.redisUrl);

    // Load Lua script asynchronously, errors handled at runtime via EVAL fallback
    this.initPromise = this.loadScript().catch(() => {
      this.scriptHash = null;
    });
  }

  private async loadScript(): Promise<void> {
    try {
      this.scriptHash = await (this.redis as any).script('load', LUA_SCRIPT);
    } catch {
      // Script loading failed - will use EVAL fallback at runtime
      this.scriptHash = null;
    }
  }

  private async getRedisTime(): Promise<number> {
    try {
      const time = await this.redis.time();
      return time[0] * 1000 + Math.round(time[1] / 1000);
    } catch {
      return Date.now();
    }
  }

  async check(key: string): Promise<CheckResult> {
    const prefixedKey = `rl:${key}`;

    try {
      // Wait for script to load (if still initializing)
      await this.initPromise;

      const now = await this.getRedisTime();
      const args = [String(this.burst), String(this.refillRate), String(this.refillInterval), String(now)];

      let result: [number, number, number];

      if (this.scriptHash) {
        try {
          result = (await (this.redis as any).evalsha(this.scriptHash, 1, prefixedKey, ...args)) as [number, number, number];
        } catch (err: unknown) {
          if (err instanceof Error && err.message.includes('NOSCRIPT')) {
            // Fallback to EVAL, then reload script
            result = (await (this.redis as any).eval(LUA_SCRIPT, 1, prefixedKey, ...args)) as [number, number, number];
            this.loadScript(); // Fire-and-forget: reload script for future calls
          } else {
            throw err;
          }
        }
      } else {
        // No script hash available, use EVAL directly
        result = (await (this.redis as any).eval(LUA_SCRIPT, 1, prefixedKey, ...args)) as [number, number, number];
      }

      const [allowed, tokens, retryAfter] = result;

      if (!allowed) {
        this.logger?.warn(`Rate limit exceeded for key: ${key}`, { retryAfter });
      }

      return {
        allowed: allowed === 1,
        limit: this.burst,
        remaining: tokens,
        resetTime: now + this.refillInterval,
        retryAfter,
      };

    } catch (err) {
      this.logger?.error('Redis store error', err);

      if (this.failOpen) {
        return {
          allowed: true,
          limit: this.burst,
          remaining: this.burst,
          resetTime: Date.now() + this.refillInterval,
          retryAfter: 0,
        };
      }

      return {
        allowed: false,
        limit: this.burst,
        remaining: 0,
        resetTime: Date.now() + this.refillInterval,
        retryAfter: Math.ceil(this.refillInterval / 1000),
      };
    }
  }

  async shutdown(): Promise<void> {
    await this.redis.quit();
  }
}
