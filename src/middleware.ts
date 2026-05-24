import type { RateLimitStore } from "./store";
import {
  type CheckResult,
  type RateLimitMiddleware,
  type RateLimitNext,
} from "./types";

export type RateLimiterLogger = {
  warn(message: string, error?: unknown): void;
};

type RateLimitHeaderValues = {
  limit: string;
  remaining: string;
  retryAfter: string;
};

export function createRateLimiter(
  store: RateLimitStore,
  logger: RateLimiterLogger = console,
): RateLimitMiddleware {
  return async (key, next) => {
    let headerValues: RateLimitHeaderValues;

    try {
      const result = await store.check(key);
      headerValues = getRateLimitHeaderValues(result);

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

function getRateLimitHeaderValues(result: CheckResult): RateLimitHeaderValues {
  return {
    limit: String(result.limit),
    remaining: String(result.remaining),
    retryAfter: String(getRetryAfterHeaderValue(result)),
  };
}

function setRateLimitHeaders(headers: Headers, values: RateLimitHeaderValues): void {
  headers.set("X-RateLimit-Limit", values.limit);
  headers.set("X-RateLimit-Remaining", values.remaining);
  headers.set("Retry-After", values.retryAfter);
}

function getRetryAfterHeaderValue(result: CheckResult): number {
  if (result.allowed || result.retryAfter <= 0) {
    return 0;
  }

  return Math.max(0, Math.ceil((result.retryAfter - Date.now()) / 1000));
}
