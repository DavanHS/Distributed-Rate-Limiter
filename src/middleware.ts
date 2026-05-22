import { resolveKey, type KeyResolverLogger } from "./key-resolver";
import type { RateLimitStore } from "./store";
import {
  RateLimitOptionsSchema,
  type CheckResult,
  type RateLimitMiddleware,
  type RateLimitNext,
  type RateLimitOptionsInput,
} from "./types";

/**
 * Logger type used by the middleware for warning messages.
 *
 * Aliased from `KeyResolverLogger` — any object with a `warn` method works.
 */
export type RateLimiterLogger = KeyResolverLogger;

type RateLimitHeaderValues = {
  limit: string;
  remaining: string;
  retryAfter: string;
};

/**
 * Creates a rate limiting middleware function.
 *
 * The returned middleware accepts a `RateLimitRequest` and a `next` handler.
 * It resolves the rate limit key (custom resolver or IP fallback), checks
 * the store, and either:
 * - Returns a 429 JSON response if the request is denied.
 * - Calls `next()` and decorates the response with rate limit headers if allowed.
 *
 * Runtime errors are caught and fail-open — the request is allowed through
 * and a warning is logged. This ensures your API stays available even if
 * the rate limiter encounters an issue.
 *
 * Configuration is validated at creation time via Zod. Invalid options
 * throw immediately so misconfigurations are caught before deployment.
 *
 * @param store - The rate limit store (in-memory or Redis).
 * @param options - Rate limit configuration. Defaults: 500 burst, 50/s refill, 1s interval.
 * @param logger - Logger for warning messages. Defaults to `console`.
 * @returns A `RateLimitMiddleware` function.
 *
 * @example
 * ```ts
 * import { createRateLimiter, RedisStore } from "@davanhs/rate-limiter";
 *
 * const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
 * const limiter = createRateLimiter(store, { burst: 100, refillRate: 10 });
 *
 * const response = await limiter(
 *   { headers: request.headers, ip: "192.168.1.1" },
 *   () => new Response("Hello!")
 * );
 * ```
 */
export function createRateLimiter(
  store: RateLimitStore,
  options: RateLimitOptionsInput = {},
  logger: RateLimiterLogger = console,
): RateLimitMiddleware {
  const config = RateLimitOptionsSchema.parse(options);

  return async (req, next) => {
    let headerValues: RateLimitHeaderValues;

    try {
      const key = await resolveKey(req, config, logger);
      const result = await store.check(key);
      headerValues = getRateLimitHeaderValues(result, config.burst);

      if (!result.allowed) {
        return rateLimitExceededResponse(result, headerValues);
      }
    } catch (error) {
      logger.warn("Rate limiter failed open. Allowing request.", error);
      return next();
    }

    const response = await next();

    if (response) {
      return withRateLimitHeaders(response, headerValues);
    }

    return response;
  };
}

/**
 * Creates a 429 response for a rate-limited request.
 *
 * Returns a JSON body with `error` and `retryAfter` fields,
 * plus standard rate limit headers.
 *
 * @param result - The check result from the store.
 * @param headerValues - Precomputed header values.
 * @returns A 429 Response object.
 */
function rateLimitExceededResponse(result: CheckResult, headerValues: RateLimitHeaderValues): Response {
  const headers = new Headers({ "content-type": "application/json" });
  setRateLimitHeaders(headers, headerValues);

  return new Response(
    JSON.stringify({
      error: "Rate limit exceeded",
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers,
    },
  );
}

/**
 * Adds rate limit headers to an existing response.
 *
 * If the response's `headers` object is immutable, creates a new
 * response with copied body, status, and the added headers.
 *
 * @param response - The response to decorate.
 * @param headerValues - The header values to set.
 * @returns The response with rate limit headers.
 */
function withRateLimitHeaders(response: Response, headerValues: RateLimitHeaderValues): Response {
  try {
    setRateLimitHeaders(response.headers, headerValues);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    setRateLimitHeaders(headers, headerValues);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * Converts a `CheckResult` and burst value into header string values.
 *
 * @param result - The check result from the store.
 * @param limit - The burst capacity (X-RateLimit-Limit).
 * @returns An object with `limit`, `remaining`, and `retryAfter` strings.
 */
function getRateLimitHeaderValues(result: CheckResult, limit: number): RateLimitHeaderValues {
  return {
    limit: String(limit),
    remaining: String(result.remaining),
    retryAfter: String(getRetryAfterHeaderValue(result)),
  };
}

/**
 * Sets standard rate limit headers on a `Headers` object.
 *
 * Headers set:
 * - `X-RateLimit-Limit`: The burst capacity.
 * - `X-RateLimit-Remaining`: Tokens remaining after this request.
 * - `Retry-After`: Seconds until the client can retry (0 when allowed).
 *
 * @param headers - The Headers object to modify.
 * @param values - The header values to set.
 */
function setRateLimitHeaders(headers: Headers, values: RateLimitHeaderValues): void {
  headers.set("X-RateLimit-Limit", values.limit);
  headers.set("X-RateLimit-Remaining", values.remaining);
  headers.set("Retry-After", values.retryAfter);
}

/**
 * Calculates the `Retry-After` header value in seconds.
 *
 * Returns 0 when the request is allowed. Otherwise, computes the
 * seconds remaining until the token bucket refills.
 *
 * @param result - The check result from the store.
 * @returns Seconds until retry, or 0.
 */
function getRetryAfterHeaderValue(result: CheckResult): number {
  if (result.allowed || result.retryAfter <= 0) {
    return 0;
  }

  return Math.max(0, Math.ceil((result.retryAfter - Date.now()) / 1000));
}
