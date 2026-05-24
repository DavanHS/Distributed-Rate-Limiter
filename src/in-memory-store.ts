import type { TokenBucketOptionsInput, CheckResult } from "./types";
import { TokenBucketOptionsSchema } from "./types";
import type { RateLimitStore } from "./store";

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

export class InMemoryStore implements RateLimitStore {
  private store: Map<string, TokenBucketState>;
  private burst: number;
  private refillRate: number;
  private refillInterval: number;
  private maxKeys: number = 10000;
  private ttlMs: number;

  constructor(options: TokenBucketOptionsInput = {}) {
    const config = TokenBucketOptionsSchema.parse(options);
    this.burst = config.burst;
    this.refillRate = config.refillRate;
    this.refillInterval = config.refillInterval;
    this.ttlMs = this.refillInterval * 2;
    this.store = new Map();
  }

  private evictLRU() {
    if (this.store.size > this.maxKeys) {
      const firstKey = this.store.keys().next().value;
      if (firstKey) {
        this.store.delete(firstKey);
      }
    }
  }

  private cleanupExpired(now: number) {
    for (const [key, state] of this.store.entries()) {
      if (now - state.lastRefill > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }

  async check(rawKey: string): Promise<CheckResult> {
    const key = `rl:${rawKey}`;
    const now = Date.now();

    this.cleanupExpired(now);

    let state = this.store.get(key);

    if (state) {
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
      limit: this.burst,
      remaining: Math.max(0, remaining),
      resetTime,
      retryAfter,
    };
  }
}
