import { z } from 'zod';
import type { CheckResult, RateLimitStore, Logger, TokenBucketOptions } from './types.js';
import { TokenBucketOptionsSchema } from './types.js';

interface BucketEntry {
  tokens: number;
  lastRefill: number;
  lastAccess: number;
}

export class InMemoryStore implements RateLimitStore {
  private cache = new Map<string, BucketEntry>();
  private readonly burst: number;
  private readonly refillRate: number;
  private readonly refillInterval: number;
  private readonly ttl: number;
  private readonly maxKeys = 10_000;
  private logger?: Logger;

  constructor(options?: Partial<TokenBucketOptions>, logger?: Logger) {
    const parsed = TokenBucketOptionsSchema.parse(options ?? {});
    this.burst = parsed.burst;
    this.refillRate = parsed.refillRate;
    this.refillInterval = parsed.refillInterval;
    this.ttl = this.refillInterval * 2;
    this.logger = logger;
  }

  async check(key: string): Promise<CheckResult> {
    const now = Date.now();
    const prefixedKey = `rl:${key}`;
    let entry = this.cache.get(prefixedKey);

    // Lazy TTL eviction: check expiration inline on access
    if (entry && (now - entry.lastRefill) >= this.ttl) {
      this.cache.delete(prefixedKey);
      entry = undefined;
    }

    // LRU eviction: if at capacity and key is new, evict oldest
    if (!entry && this.cache.size >= this.maxKeys) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    // Initialize new bucket if entry doesn't exist
    if (!entry) {
      entry = {
        tokens: this.burst,
        lastRefill: now,
        lastAccess: now,
      };
      this.cache.set(prefixedKey, entry);
    }

    // Step-wise interval advancement with clock skew clamping
    const elapsed = Math.max(0, now - entry.lastRefill);
    const intervals = Math.floor(elapsed / this.refillInterval);
    if (intervals > 0) {
      entry.tokens = Math.min(this.burst, entry.tokens + (intervals * this.refillRate));
      entry.lastRefill += intervals * this.refillInterval;
    }

    // Update last access time for LRU
    entry.lastAccess = now;

    // Check if request is allowed
    const allowed = entry.tokens >= 1;
    let retryAfter = 0;

    if (allowed) {
      entry.tokens -= 1;
    } else {
      // Calculate time until next token
      const msToNextToken = this.refillInterval - (now - entry.lastRefill);
      retryAfter = Math.max(1, Math.ceil(msToNextToken / 1000));
      this.logger?.warn(`Rate limit exceeded for key: ${key}`, { retryAfter });
    }

    return {
      allowed,
      limit: this.burst,
      remaining: entry.tokens,
      resetTime: entry.lastRefill + this.refillInterval,
      retryAfter,
    };
  }

  async shutdown(): Promise<void> {
    this.cache.clear();
  }
}
