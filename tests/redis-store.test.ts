import { describe, expect, mock, test } from "bun:test";

type Call = {
  command: string;
  args: unknown[];
};

class FakeRedis {
  static instances: FakeRedis[] = [];

  calls: Call[] = [];
  scriptResult: unknown = "sha1";
  evalshaResult: unknown = [1, 499, 1_700_000_001_000, 0];
  evalResult: unknown = [1, 499, 1_700_000_001_000, 0];
  timeResult: Array<string | number> = ["1700000000", "123000"];
  scriptError: unknown;
  evalshaError: unknown;
  evalError: unknown;
  timeError: unknown;

  constructor(
    readonly redisUrl: string,
    readonly options: Record<string, unknown>,
  ) {
    FakeRedis.instances.push(this);
  }

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

mock.module("ioredis", () => ({
  default: FakeRedis,
}));

const { RedisLimiterInitError } = await import("../src/errors");
const { RedisStore } = await import("../src/redis-store");
type RedisStoreLogger = import("../src/redis-store").RedisStoreLogger;

function latestRedis(): FakeRedis {
  const redis = FakeRedis.instances.at(-1);

  if (!redis) {
    throw new Error("FakeRedis was not constructed.");
  }

  return redis;
}

describe("RedisStore", () => {
  test("throws RedisLimiterInitError for missing redisUrl", () => {
    expect(() => new RedisStore({} as never)).toThrow(RedisLimiterInitError);
  });

  test("creates its own Redis client from redisUrl", () => {
    FakeRedis.instances = [];

    new RedisStore({ redisUrl: "redis://localhost:6379" });

    const redis = latestRedis();
    expect(redis.redisUrl).toBe("redis://localhost:6379");
    expect(redis.options).toMatchObject({
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  });

  test("loads Lua script and runs EVALSHA with exact Redis key and config args", async () => {
    FakeRedis.instances = [];
    const store = new RedisStore({
      redisUrl: "redis://localhost:6379",
      burst: 500,
      refillRate: 50,
      refillInterval: 1000,
    });
    const redis = latestRedis();

    const result = await store.check("  USER:42  ");

    expect(result).toEqual({
      allowed: true,
      limit: 500,
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
      "rl:  USER:42  ",
      1_700_000_000_123,
      500,
      50,
      1000,
      2000,
    ]);
  });

  test("falls back to EVAL when EVALSHA returns NOSCRIPT", async () => {
    FakeRedis.instances = [];
    const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
    const redis = latestRedis();
    redis.evalshaError = new Error("NOSCRIPT No matching script. Please use EVAL.");
    redis.evalResult = [0, 0, 1_700_000_001_000, 1_700_000_001_000];

    const result = await store.check("client");

    expect(result).toEqual({
      allowed: false,
      limit: 500,
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
    FakeRedis.instances = [];
    const now = Date.now();
    const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
    const redis = latestRedis();
    redis.timeError = new Error("TIME unavailable");

    await store.check("client");

    const evalshaArgs = redis.calls.find((call) => call.command === "evalsha")?.args;
    expect(Number(evalshaArgs?.[3])).toBeGreaterThanOrEqual(now);
  });

  test("fails open and logs warning when Redis runtime work throws", async () => {
    FakeRedis.instances = [];
    const logger: RedisStoreLogger = { warn: mock() };
    const store = new RedisStore({ redisUrl: "redis://localhost:6379", burst: 20 }, logger);
    const redis = latestRedis();
    redis.scriptError = new Error("Redis down");

    const result = await store.check("client");

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(20);
    expect(result.remaining).toBe(20);
    expect(result.retryAfter).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
