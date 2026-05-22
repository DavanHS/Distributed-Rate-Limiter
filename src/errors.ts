/**
 * Base error class for all rate limiter errors.
 *
 * Used as the parent class for more specific error types.
 * Catch this to handle any rate limiter error in a single block.
 *
 * @example
 * ```ts
 * try {
 *   new RedisStore({ redisUrl: "bad-url" });
 * } catch (error) {
 *   if (error instanceof RateLimiterError) {
 *     console.error("Rate limiter error:", error.message);
 *   }
 * }
 * ```
 */
export class RateLimiterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimiterError";
  }
}

/**
 * Thrown when a custom key resolver fails.
 *
 * In practice, the library catches key resolver errors and falls back
 * to IP-based resolution with a warning log instead of throwing.
 * This class exists for type safety and future extensibility.
 */
export class KeyResolverError extends RateLimiterError {
  constructor(message: string) {
    super(message);
    this.name = "KeyResolverError";
  }
}

/**
 * Thrown when `RedisStore` fails to initialize.
 *
 * Causes:
 * - Missing `redisUrl` and no injected Redis client
 * - Invalid configuration (fails Zod validation)
 * - Connection refused at startup
 *
 * Unlike runtime errors (which fail open), init errors throw
 * immediately so developers catch misconfigurations before deployment.
 *
 * @example
 * ```ts
 * try {
 *   const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
 * } catch (error) {
 *   if (error instanceof RedisLimiterInitError) {
 *     console.error("Cannot start rate limiter:", error.message);
 *     process.exit(1);
 *   }
 * }
 * ```
 */
export class RedisLimiterInitError extends RateLimiterError {
  constructor(message: string) {
    super(message);
    this.name = "RedisLimiterInitError";
  }
}
