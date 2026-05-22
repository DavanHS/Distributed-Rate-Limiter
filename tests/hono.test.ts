import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { createHonoMiddleware } from "../src/hono";
import type { RateLimitMiddleware } from "../src/types";

describe("createHonoMiddleware", () => {
  test("returns Hono middleware compatible with app.use and passes through allowed requests", async () => {
    const limiter: RateLimitMiddleware = mock(async (_req, next) => next());
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(limiter).toHaveBeenCalledTimes(1);
  });

  test("sets rate limit headers on allowed responses returned by core limiter", async () => {
    const limiter: RateLimitMiddleware = mock(async (_req, next) => {
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

  test("sets 429 status and JSON body from blocked core response", async () => {
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
    expect(response.headers.get("X-RateLimit-Limit")).toBe("20");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(response.headers.get("Retry-After")).toBe("1700000001000");
    await expect(response.json()).resolves.toEqual({
      error: "Rate limit exceeded",
      retryAfter: 1_700_000_001_000,
    });
  });

  test("passes Hono request headers to core limiter", async () => {
    const limiter: RateLimitMiddleware = mock(async (req, next) => {
      expect(req.headers.get("x-forwarded-for")).toBe("198.51.100.7");
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    await app.request("/", {
      headers: {
        "x-forwarded-for": "198.51.100.7",
      },
    });

    expect(limiter).toHaveBeenCalledTimes(1);
  });

  test("passes custom adapter IP fallback to core limiter", async () => {
    const limiter: RateLimitMiddleware = mock(async (req, next) => {
      expect(req.ip).toBe("198.51.100.42");
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter, { getIp: () => "198.51.100.42" }));
    app.get("/", (c) => c.text("ok"));

    await app.request("/");

    expect(limiter).toHaveBeenCalledTimes(1);
  });

  test("does not pass an empty IP fallback to core limiter", async () => {
    const limiter: RateLimitMiddleware = mock(async (req, next) => {
      expect(req.ip).toBe("unknown");
      return next();
    });
    const app = new Hono();

    app.use("*", createHonoMiddleware(limiter));
    app.get("/", (c) => c.text("ok"));

    await app.request("/");

    expect(limiter).toHaveBeenCalledTimes(1);
  });
});
