import { describe, expect, mock, test } from "bun:test";
import Redis from "ioredis";
import { RedisLimiterInitError } from "../src/errors";
import { RedisStore, type RedisStoreClient, type RedisStoreLogger } from "../src/redis-store";

type Call = {
  command: string;
  args: unknown[];
};

class FakeRedis implements RedisStoreClient {
  calls: Call[] = [];
  scriptResult: unknown = "sha1";
  evalshaResult: unknown = [1, 499, 1_700_000_001_000, 0];
  evalResult: unknown = [1, 499, 1_700_000_001_000, 0];
  timeResult: Array<string | number> = ["1700000000", "123000"];
  scriptError: unknown;
  evalshaError: unknown;
  evalError: unknown;
  timeError: unknown;

  async script(subcommand: "LOAD", script: string): Promise<unknown> {
    this.calls.push({ command: "script", args: [subcommand, script] });

    if (this.scriptError) {
      throw this.scriptError;
    }

    return this.scriptResult;
  }

  async evalsha(sha: string, numkeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.calls.push({ command: "evalsha", args: [sha, numkeys, ...args] });

    if (this.evalshaError) {
      throw this.evalshaError;
    }

    return this.evalshaResult;
  }

  async eval(script: string, numkeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.calls.push({ command: "eval", args: [script, numkeys, ...args] });

    if (this.evalError) {
      throw this.evalError;
    }

    return this.evalResult;
  }

  async time(): Promise<Array<string | number>> {
    this.calls.push({ command: "time", args: [] });

    if (this.timeError) {
      throw this.timeError;
    }

    return this.timeResult;
  }
}

describe("RedisStore", () => {
  test("throws RedisLimiterInitError for missing redisUrl without injected client", () => {
    expect(() => new RedisStore({})).toThrow(RedisLimiterInitError);
  });

  test("loads Lua script and runs EVALSHA with normalized Redis key and config args", async () => {
    const redis = new FakeRedis();
    const store = new RedisStore(
      { redisUrl: "redis://localhost:6379", burst: 500, refillRate: 50, refillInterval: 1000 },
      redis,
    );

    const result = await store.check("  USER:42  ");

    expect(result).toEqual({
      allowed: true,
      remaining: 499,
      resetTime: 1_700_000_001_000,
      retryAfter: 0,
    });
    expect(redis.calls.map((call) => call.command)).toEqual(["time", "script", "evalsha"]);
    expect(redis.calls[1]?.args[1]).toContain('HSET", key, "tokens", tokens, "lastRefill", lastRefill');
    expect(redis.calls[1]?.args[1]).toContain("PEXPIRE");
    expect(redis.calls[2]?.args).toEqual([
      "sha1",
      1,
      "rl:user:42",
      1_700_000_000_123,
      500,
      50,
      1000,
      2000,
    ]);
  });

  test("falls back to EVAL when EVALSHA returns NOSCRIPT", async () => {
    const redis = new FakeRedis();
    redis.evalshaError = new Error("NOSCRIPT No matching script. Please use EVAL.");
    redis.evalResult = [0, 0, 1_700_000_001_000, 1_700_000_001_000];
    const store = new RedisStore({ redisUrl: "redis://localhost:6379" }, redis);

    const result = await store.check("client");

    expect(result).toEqual({
      allowed: false,
      remaining: 0,
      resetTime: 1_700_000_001_000,
      retryAfter: 1_700_000_001_000,
    });
    expect(redis.calls.map((call) => call.command)).toEqual(["time", "script", "evalsha", "eval"]);

    redis.evalshaError = undefined;
    await store.check("client");

    expect(redis.calls.map((call) => call.command)).toEqual([
      "time",
      "script",
      "evalsha",
      "eval",
      "time",
      "script",
      "evalsha",
    ]);
  });

  test("uses Date.now when Redis TIME fails", async () => {
    const redis = new FakeRedis();
    redis.timeError = new Error("TIME unavailable");
    const now = Date.now();
    const store = new RedisStore({ redisUrl: "redis://localhost:6379" }, redis);

    await store.check("client");

    const evalshaArgs = redis.calls.find((call) => call.command === "evalsha")?.args;
    expect(Number(evalshaArgs?.[3])).toBeGreaterThanOrEqual(now);
  });

  test("fails open and logs warning when Redis runtime work throws", async () => {
    const redis = new FakeRedis();
    redis.scriptError = new Error("Redis down");
    const logger: RedisStoreLogger = { warn: mock() };
    const store = new RedisStore({ redisUrl: "redis://localhost:6379", burst: 20 }, redis, logger);

    const result = await store.check("client");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(20);
    expect(result.retryAfter).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

const redisIntegrationTest = process.env.REDIS_URL ? test : test.skip;

redisIntegrationTest("RedisStore integrates with real Redis Lua state and TTL", async () => {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    throw new Error("REDIS_URL is required for Redis integration test.");
  }

  const redis = new Redis(redisUrl);
  const rawKey = `integration:${Date.now()}`;
  const redisKey = `rl:${rawKey}`;
  const store = new RedisStore(
    { redisUrl, burst: 2, refillRate: 1, refillInterval: 1000 },
    redis,
  );

  try {
    await redis.del(redisKey);

    const first = await store.check(rawKey);
    const second = await store.check(rawKey);
    const third = await store.check(rawKey);
    const state = await redis.hgetall(redisKey);
    const ttl = await redis.pttl(redisKey);

    expect(first).toMatchObject({ allowed: true, remaining: 1, retryAfter: 0 });
    expect(second).toMatchObject({ allowed: true, remaining: 0, retryAfter: 0 });
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(Number(state.tokens)).toBe(0);
    expect(Number(state.lastRefill)).toBeGreaterThan(0);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2000);
  } finally {
    await redis.del(redisKey);
    redis.disconnect();
  }
});
