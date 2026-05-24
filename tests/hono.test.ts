import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createHonoMiddleware } from "../src/hono";
import type { RateLimitMiddleware } from "../src/types";

const SECRET_ENV = "RATE_LIMIT_COOKIE_SECRET";
const COOKIE_NAME = "__rl_id";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function setSecret(value = "test-secret") {
  process.env[SECRET_ENV] = value;
}

describe("createHonoMiddleware", () => {
  test("throws when cookie signing secret is missing", () => {
    const previous = process.env[SECRET_ENV];
    delete process.env[SECRET_ENV];
    const limiter: RateLimitMiddleware = mock(async (_key, next) => next());

    try {
      expect(() => createHonoMiddleware(limiter)).toThrow(`${SECRET_ENV} is required.`);
    } finally {
      if (previous === undefined) {
        delete process.env[SECRET_ENV];
      } else {
        process.env[SECRET_ENV] = previous;
      }
    }
  });

  test("returns Hono middleware compatible with app.use and passes through allowed requests", async () => {
    setSecret();
    const limiter: RateLimitMiddleware = mock(async (key, next) => {
      expect(key).toMatch(UUID_PATTERN);
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  test("reuses verified cookie key and does not set a new cookie", async () => {
    setSecret();
    const seenKeys: string[] = [];
    const limiter: RateLimitMiddleware = mock(async (key, next) => {
      seenKeys.push(key);
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const first = await app.request("/");
    const cookie = first.headers.get("set-cookie");
    expect(cookie).toContain(`${COOKIE_NAME}=`);

    const second = await app.request("/", {
      headers: {
        cookie: cookie!.split(";")[0]!,
      },
    });

    expect(second.status).toBe(200);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(seenKeys).toHaveLength(2);
    expect(seenKeys[1]).toBe(seenKeys[0]);
  });

  test("replaces an invalid signed cookie with a new key", async () => {
    setSecret();
    const limiter: RateLimitMiddleware = mock(async (key, next) => {
      expect(key).not.toBe("client");
      expect(key).toMatch(UUID_PATTERN);
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/", {
      headers: {
        cookie: `${COOKIE_NAME}=client.bad-signature`,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  test("sets rate limit headers on allowed responses returned by core limiter", async () => {
    setSecret();
    const limiter: RateLimitMiddleware = mock(async (_key, next) => {
      const response = await next();
      response?.headers.set("X-RateLimit-Limit", "20");
      response?.headers.set("X-RateLimit-Remaining", "19");
      response?.headers.set("Retry-After", "0");
      return response;
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("19");
    expect(response.headers.get("Retry-After")).toBe("0");
  });

  test("sets 429 status, JSON body, headers, and cookie from blocked core response", async () => {
    setSecret();
    const limiter: RateLimitMiddleware = mock(async () => {
      return Response.json(
        { error: "Rate limit exceeded", retryAfter: 1_700_000_001_000 },
        {
          status: 429,
          headers: {
            "X-RateLimit-Limit": "20",
            "X-RateLimit-Remaining": "0",
            "Retry-After": "1700000001000",
          },
        },
      );
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/");

    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=`);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBe("1700000001000");
    await expect(response.json()).resolves.toEqual({
      error: "Rate limit exceeded",
      retryAfter: 1_700_000_001_000,
    });
  });
});
