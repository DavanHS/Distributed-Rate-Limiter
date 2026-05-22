import type { Context, MiddlewareHandler, Next } from "hono";
import type { RateLimitMiddleware, RateLimitRequest } from "./types";

/**
 * Configuration options for the Hono middleware adapter.
 */
export type HonoMiddlewareOptions = {
  /**
   * Custom IP extraction function.
   *
   * Override the default IP detection logic if your deployment
   * uses non-standard headers (e.g. a custom load balancer header).
   *
   * @example
   * ```ts
   * createHonoMiddleware(limiter, {
   *   getIp: (c) => c.req.header("x-custom-ip"),
   * });
   * ```
   */
  getIp?: (c: Context) => string | undefined;
};

/**
 * Wraps a `RateLimitMiddleware` into a Hono `MiddlewareHandler`.
 *
 * Converts Hono's `Context` into a `RateLimitRequest`, delegates to
 * the core rate limiter, and handles the response:
 * - Returns a 429 JSON response when rate limited.
 * - Passes through to `next()` when allowed, decorating the response
 *   with rate limit headers.
 *
 * The core limiter is framework-agnostic — this adapter is the bridge
 * that makes it work with Hono's request/response model.
 *
 * @param limiter - A `RateLimitMiddleware` created by `createRateLimiter()`.
 * @param options - Optional configuration for IP extraction.
 * @returns A Hono `MiddlewareHandler` usable with `app.use()`.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createRateLimiter, RedisStore } from "@davanhs/rate-limiter";
 * import { createHonoMiddleware } from "@davanhs/rate-limiter/hono";
 *
 * const app = new Hono();
 * const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
 * const limiter = createRateLimiter(store);
 *
 * app.use("*", createHonoMiddleware(limiter));
 * ```
 */
export function createHonoMiddleware(
  limiter: RateLimitMiddleware,
  options: HonoMiddlewareOptions = {},
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const response = await limiter(toRateLimitRequest(c, options), async () => {
      await next();
      return c.res;
    });

    if (!response) {
      return;
    }

    if (response.status === 429) {
      c.status(429);
      return c.json(await response.json(), 429, responseHeadersToRecord(response.headers));
    }

    c.res = response;
    return response;
  };
}

/**
 * Converts a Hono `Context` into a `RateLimitRequest`.
 *
 * Extracts headers from the raw Fetch request and determines the client
 * IP using the configured fallback chain.
 *
 * @param c - The Hono context.
 * @param options - Middleware options containing optional `getIp`.
 * @returns A `RateLimitRequest` for the core limiter.
 */
function toRateLimitRequest(c: Context, options: HonoMiddlewareOptions): RateLimitRequest {
  return {
    headers: c.req.raw.headers,
    ip: getClientIp(c, options),
  };
}

/**
 * Extracts the client IP address from a Hono context.
 *
 * Fallback chain (first match wins):
 * 1. `options.getIp(c)` — custom extractor
 * 2. `x-real-ip` header
 * 3. `cf-connecting-ip` header (Cloudflare)
 * 4. First IP from `x-forwarded-for` header
 * 5. `"unknown"` — final fallback
 *
 * @param c - The Hono context.
 * @param options - Middleware options.
 * @returns The client IP address.
 */
function getClientIp(c: Context, options: HonoMiddlewareOptions): string {
  return (
    options.getIp?.(c)?.trim() ||
    c.req.header("x-real-ip")?.trim() ||
    c.req.header("cf-connecting-ip")?.trim() ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

/**
 * Converts a `Headers` object to a plain record.
 *
 * Used to pass rate limit headers to Hono's `c.json()` method,
 * which expects a `Record<string, string>` rather than a `Headers` object.
 *
 * @param headers - The Fetch `Headers` object.
 * @returns A plain record of header key-value pairs.
 */
function responseHeadersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};

  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }

  return record;
}
