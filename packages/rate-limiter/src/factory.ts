import type { RateLimitStore, RateLimitMiddleware, Logger } from './types.js';
import { getRateLimitDetails } from './utils.js';

export function createRateLimiter(
  store: RateLimitStore,
  logger?: Logger,
): RateLimitMiddleware {
  return async (key: string, next: () => Promise<void>) => {
    try {
      const result = await store.check(key);
      const details = getRateLimitDetails(result);

      if (result.allowed) {
        await next();
      }

      return {
        allowed: result.allowed,
        headers: details.headers,
        body: details.body,
      };
    } catch (err) {
      logger?.error('Rate limiter error, failing open', err);

      // Fail-open: allow request through on unexpected errors
      await next();

      return {
        allowed: true,
        headers: {},
        body: null,
      };
    }
  };
}
