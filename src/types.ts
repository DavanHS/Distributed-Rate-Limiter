import { z } from "zod";

/**
 * The result of a rate limit check.
 *
 * Returned by `RateLimitStore.check()` and used by the middleware
 * to decide whether to allow or deny a request.
 *
 * All timestamps are absolute Unix epoch milliseconds.
 */
export type CheckResult = {
  /** Whether the request is allowed to proceed. */
  allowed: boolean;
  /**
   * Number of tokens remaining after this check.
   * Always 0 or greater — never negative.
   */
  remaining: number;
  /**
   * Absolute Unix epoch milliseconds when the token bucket
   * will next refill. Useful for `X-RateLimit-Reset` headers.
   */
  resetTime: number;
  /**
   * Absolute Unix epoch milliseconds when the client can retry.
   * Set to 0 when the request is allowed.
   */
  retryAfter: number;
};

/**
 * A value that may be synchronous or a Promise.
 * Used for key resolvers and next handlers that can be async.
 */
export type MaybePromise<T> = T | Promise<T>;

/**
 * A source of HTTP headers that the rate limiter can read from.
 *
 * Accepts the standard `Headers` API, any object with a `get(name)` method,
 * or a plain record. This lets the core work with Fetch, Hono, Express,
 * and any other request shape without coupling to a specific framework.
 */
export type HeaderSource =
  | Headers
  | {
      get(name: string): string | null | undefined;
    }
  | Record<string, string | string[] | undefined>;

/**
 * A normalized request object that the rate limiter operates on.
 *
 * The middleware adapters (e.g. Hono) convert their framework-specific
 * request into this shape so the core logic stays framework-agnostic.
 */
export type RateLimitRequest = {
  /** HTTP headers for key resolution (e.g. x-forwarded-for, authorization). */
  headers: HeaderSource;
  /** Client IP address, used as the fallback key when no custom resolver is provided. */
  ip: string;
};

/**
 * A function that extracts a rate limit key from a request.
 *
 * Common patterns: API key from `Authorization` header, user ID from a JWT,
 * session ID from a cookie. Return `null`/`undefined`/empty string to fall
 * back to IP-based resolution.
 *
 * @example
 * ```ts
 * const keyResolver = (req) => req.headers.get("authorization");
 * ```
 */
export type KeyResolver = (req: RateLimitRequest) => MaybePromise<string | null | undefined>;

/**
 * The next handler in the middleware chain.
 *
 * Called when a request is allowed through the rate limiter.
 * Returns the downstream response, or `undefined` if no response was produced.
 */
export type RateLimitNext = () => MaybePromise<Response | undefined>;

/**
 * A rate limiting middleware function.
 *
 * Accepts a `RateLimitRequest` and a `next` handler. Returns a `Response`
 * when the request is denied (429), or `undefined` when allowed (caller
 * should invoke `next()`).
 *
 * Created by `createRateLimiter()`.
 */
export type RateLimitMiddleware = (
  req: RateLimitRequest,
  next: RateLimitNext,
) => Promise<Response | undefined>;

/**
 * Zod schema for validating rate limiter configuration.
 *
 * Applied at initialization time — invalid options throw immediately
 * so misconfigurations are caught before the app starts serving traffic.
 *
 * Defaults: `burst: 500`, `refillRate: 50`, `refillInterval: 1000` (ms).
 */
export const RateLimitOptionsSchema = z.object({
  /** Maximum token bucket capacity. Controls burst size. */
  burst: z.number().int().positive().default(500),
  /** Number of tokens added per refill interval. Controls sustained throughput. */
  refillRate: z.number().int().positive().default(50),
  /** Milliseconds between token refills. */
  refillInterval: z.number().int().positive().default(1000),
  /** Custom key resolver. Falls back to IP-based resolution if omitted or returns empty. */
  keyResolver: z.custom<KeyResolver>((value) => typeof value === "function").optional(),
  /** Redis connection URL. Required when using `RedisStore`. */
  redisUrl: z.string().url().optional(),
});

/** Input type for `RateLimitOptionsSchema` — what you pass to constructors. */
export type RateLimitOptionsInput = z.input<typeof RateLimitOptionsSchema>;

/** Output type for `RateLimitOptionsSchema` — resolved config with defaults applied. */
export type RateLimitOptions = z.output<typeof RateLimitOptionsSchema>;
