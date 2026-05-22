import type { RateLimitOptionsInput, CheckResult } from "./types";
import { RateLimitOptionsSchema } from "./types";
import type { RateLimitStore } from "./store";
import { normalizeKey } from "./key-resolver";

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

/**
 * An in-memory rate limit store using a JavaScript `Map`.
 *
 * Suitable for single-node deployments where all requests hit the same
 * process. State is lost on restart and is not shared across processes
 * or servers.
 *
 * Uses a token bucket algorithm with hybrid eviction:
 * - **TTL-based**: Entries older than 2× the refill interval are cleaned
 *   up on every `check()` call.
 * - **LRU-based**: When the store exceeds 10,000 keys, the least recently
 *   used key is evicted.
 *
 * Defaults: 500 burst capacity, 50 tokens/second refill, 1 second interval.
 *
 * @example
 * ```ts
 * import { InMemoryStore } from "@davanhs/rate-limiter";
 *
 * const store = new InMemoryStore({ burst: 100, refillRate: 10, refillInterval: 1000 });
 * const result = await store.check("192.168.1.1");
 * console.log(result.allowed); // true
 * console.log(result.remaining); // 499
 * ```
 */
export class InMemoryStore implements RateLimitStore {
  private store: Map<string, TokenBucketState>;
  private burst: number;
  private refillRate: number;
  private refillInterval: number;
  private maxKeys: number = 10000;
  private ttlMs: number;

  /**
   * Creates a new in-memory store.
   *
   * @param options - Rate limit configuration. Defaults to 500 burst, 50/s refill, 1s interval.
   */
  constructor(options: RateLimitOptionsInput = {}) {
    const config = RateLimitOptionsSchema.parse(options);
    this.burst = config.burst;
    this.refillRate = config.refillRate;
    this.refillInterval = config.refillInterval;
    // TTL is 2x refill interval — entries older than this are considered stale.
    this.ttlMs = this.refillInterval * 2;
    this.store = new Map();
  }

  /**
   * Evicts the least recently used key when the store exceeds `maxKeys`.
   *
   * JavaScript `Map` iteration order equals insertion order, so the first
   * key is the oldest/least recently accessed. Keys are re-inserted on
   * every access to maintain LRU ordering.
   */
  private evictLRU() {
    if (this.store.size > this.maxKeys) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) {
        this.store.delete(firstKey);
      }
    }
  }

  /**
   * Removes all entries whose last refill timestamp is older than `ttlMs`.
   *
   * Runs on every `check()` call to keep memory usage bounded.
   *
   * @param now - The current timestamp in milliseconds.
   */
  private cleanupExpired(now: number) {
    for (const [key, state] of this.store.entries()) {
      if (now - state.lastRefill > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Checks whether a key has tokens remaining and consumes one if allowed.
   *
   * The token bucket algorithm:
   * 1. Normalize the key and clean up expired entries.
   * 2. Create a new bucket at full capacity if the key is unseen.
   * 3. Refill tokens based on elapsed time since last access.
   * 4. Consume one token if available.
   * 5. Update the bucket state and evict LRU if over capacity.
   *
   * @param rawKey - The raw rate limit key (e.g. IP address, user ID).
   * @returns A `CheckResult` indicating whether the request is allowed.
   */
  async check(rawKey: string): Promise<CheckResult> {
    const key = `rl:${normalizeKey(rawKey)}`;
    const now = Date.now();

    this.cleanupExpired(now);

    let state = this.store.get(key);

    if (state) {
      // Re-insert for LRU order.
      this.store.delete(key);
    } else {
      state = { tokens: this.burst, lastRefill: now };
    }

    const timePassed = now - state.lastRefill;
    const intervalsPassed = Math.floor(timePassed / this.refillInterval);

    if (intervalsPassed > 0) {
      const newTokens = Math.min(this.burst, state.tokens + intervalsPassed * this.refillRate);
      state.tokens = newTokens;
      state.lastRefill = state.lastRefill + intervalsPassed * this.refillInterval;
    }

    let allowed = false;
    let remaining = state.tokens;

    if (state.tokens >= 1) {
      allowed = true;
      state.tokens -= 1;
      remaining = state.tokens;
    }

    this.store.set(key, state);
    this.evictLRU();

    const nextRefill = state.lastRefill + this.refillInterval;
    const resetTime = nextRefill;
    const retryAfter = allowed ? 0 : nextRefill;

    return {
      allowed,
      remaining: Math.max(0, remaining),
      resetTime,
      retryAfter,
    };
  }
}
