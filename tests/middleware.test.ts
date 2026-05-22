import { describe, expect, mock, test } from "bun:test";
import { createRateLimiter, type RateLimiterLogger } from "../src/middleware";
import type { CheckResult, RateLimitRequest } from "../src/types";
import type { RateLimitStore } from "../src/store";

function request(ip = "203.0.113.10"): RateLimitRequest {
  return { headers: new Headers(), ip };
}

function storeReturning(result: CheckResult): RateLimitStore {
  return {
    check: mock(async () => result),
  };
}

describe("createRateLimiter", () => {
  test("validates options at initialization", () => {
    const store = storeReturning({
      allowed: true,
      remaining: 499,
      resetTime: 1_700_000_000_000,
      retryAfter: 0,
    });

    expect(() => createRateLimiter(store, { burst: -1 })).toThrow();
  });

  test("passes allowed requests to next and sets rate limit headers", async () => {
    const store = storeReturning({
      allowed: true,
      remaining: 12,
      resetTime: 1_700_000_000_000,
      retryAfter: 0,
    });
    const limiter = createRateLimiter(store, { burst: 20 });
    const next = mock(async () => new Response("ok"));

    const response = await limiter(request(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("ok");
    expect(response?.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(response?.headers.get("X-RateLimit-Remaining")).toBe("12");
    expect(response?.headers.get("Retry-After")).toBe("0");
  });

  test("returns 429 JSON response when store denies request", async () => {
    const originalDateNow = Date.now;
    Date.now = () => 1_700_000_000_000;
    const store = storeReturning({
      allowed: false,
      remaining: 0,
      resetTime: 1_700_000_000_000,
      retryAfter: 1_700_000_001_000,
    });
    const limiter = createRateLimiter(store, { burst: 20 });
    const next = mock(async () => new Response("ok"));

    try {
      const response = await limiter(request(), next);

      expect(next).not.toHaveBeenCalled();
      expect(response?.status).toBe(429);
      expect(response?.headers.get("content-type")).toBe("application/json");
      expect(response?.headers.get("X-RateLimit-Limit")).toBe("20");
      expect(response?.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(response?.headers.get("Retry-After")).toBe("1");
      await expect(response?.json()).resolves.toEqual({
        error: "Rate limit exceeded",
        retryAfter: 1_700_000_001_000,
      });
    } finally {
      Date.now = originalDateNow;
    }
  });

  test("uses custom keyResolver before checking store", async () => {
    const store = storeReturning({
      allowed: true,
      remaining: 1,
      resetTime: 1_700_000_000_000,
      retryAfter: 0,
    });
    const limiter = createRateLimiter(store, { keyResolver: () => "  USER:42  " });

    await limiter(request(), async () => new Response("ok"));

    expect(store.check).toHaveBeenCalledWith("user:42");
  });

  test("fails open when runtime rate limiter work throws", async () => {
    const store: RateLimitStore = {
      check: mock(async () => {
        throw new Error("store down");
      }),
    };
    const logger: RateLimiterLogger = { warn: mock() };
    const limiter = createRateLimiter(store, {}, logger);
    const next = mock(async () => new Response("ok"));

    const response = await limiter(request(), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("ok");
  });
});
