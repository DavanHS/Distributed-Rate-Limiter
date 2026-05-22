import type { CheckResult } from "./types";

/**
 * The interface that all rate limit storage backends must implement.
 *
 * A store is responsible for tracking token bucket state per key.
 * Implementations can be in-memory (single node), Redis (distributed),
 * or any other backend that supports atomic read-modify-write operations.
 *
 * The single `check()` method encapsulates the entire token bucket algorithm:
 * read current state, refill tokens based on elapsed time, consume one token,
 * persist updated state, and return the result.
 *
 * @example
 * ```ts
 * const store = new InMemoryStore();
 * const result = await store.check("192.168.1.1");
 * console.log(result.allowed); // true or false
 * ```
 */
export interface RateLimitStore {
  /**
   * Checks whether a key has tokens remaining and consumes one if allowed.
   *
   * This is an atomic operation. For distributed stores (Redis), the
   * token bucket logic runs in a Lua script to prevent race conditions.
   *
   * @param key - The normalized rate limit key (e.g. IP address, user ID, API key).
   * @returns A `CheckResult` with `allowed`, `remaining`, `resetTime`, and `retryAfter`.
   */
  check(key: string): Promise<CheckResult>;
}
