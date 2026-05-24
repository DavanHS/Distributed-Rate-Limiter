import { describe, expect, mock, test } from "bun:test";
import { createRateLimiter, type RateLimiterLogger } from "../src/middleware";
import type { CheckResult } from "../src/types";
import type { RateLimitStore } from "../src/store";

function storeReturning(result: CheckResult): RateLimitStore {
  return {
    check: mock(async () => result),
  };
}

describe("createRateLimiter", () => {
  test("creates middleware without duplicate rate options", () => {
    const store = storeReturning({
      allowed: true,
      limit: 500,
      remaining: 499,
      resetTime: 1_700_000_000_000,
      retryAfter: 0,
    });

    expect(() => createRateLimiter(store)).not.toThrow();
  });

  test("passes allowed requests to next and sets rate limit headers", async () => {
    const store = storeReturning({
      allowed: true,
      limit: 20,
      remaining: 12,
      resetTime: 1_700_000_000_000,
      retryAfter: 0,
    });
    const limiter = createRateLimiter(store);
    const next = mock(async () => new Response("ok"));

    const response = await limiter("client", next);

    expect(store.check).toHaveBeenCalledWith("client");
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
      limit: 20,
      remaining: 0,
      resetTime: 1_700_000_000_000,
      retryAfter: 1_700_000_001_000,
    });
    const limiter = createRateLimiter(store);
    const next = mock(async () => new Response("ok"));

    try {
      const response = await limiter("client", next);

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

  test("fails open when runtime rate limiter work throws", async () => {
    const store: RateLimitStore = {
      check: mock(async () => {
        throw new Error("store down");
      }),
    };
    const logger: RateLimiterLogger = { warn: mock() };
    const limiter = createRateLimiter(store, logger);
    const next = mock(async () => new Response("ok"));

    const response = await limiter("client", next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("ok");
  });
});
