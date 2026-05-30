import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryStore } from '../src/in-memory-store.js';

describe('InMemoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('default settings', () => {
    it('should use default token bucket options', async () => {
      const store = new InMemoryStore();
      const result = await store.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(500);
      expect(result.remaining).toBe(499);
      expect(result.retryAfter).toBe(0);

      await store.shutdown();
    });

    it('should decrement tokens on each check', async () => {
      const store = new InMemoryStore();
      
      const result1 = await store.check('test-key');
      expect(result1.remaining).toBe(499);

      const result2 = await store.check('test-key');
      expect(result2.remaining).toBe(498);

      await store.shutdown();
    });
  });

  describe('burst exhaustion + refill', () => {
    it('should exhaust bucket and deny requests', async () => {
      const store = new InMemoryStore({ burst: 5, refillRate: 1, refillInterval: 1000 });

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        await store.check('test-key');
      }

      // Should be denied
      const result = await store.check('test-key');
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);

      await store.shutdown();
    });

    it('should refill tokens after interval', async () => {
      const store = new InMemoryStore({ burst: 5, refillRate: 2, refillInterval: 1000 });

      // Exhaust bucket
      for (let i = 0; i < 5; i++) {
        await store.check('test-key');
      }

      // Advance time by 1 interval
      vi.setSystemTime(Date.now() + 1000);

      const result = await store.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1); // 0 + 2 refill - 1 consumed = 1

      await store.shutdown();
    });
  });

  describe('lazy TTL eviction', () => {
    it('should evict expired entries on access', async () => {
      const store = new InMemoryStore({ burst: 10, refillRate: 1, refillInterval: 1000 });

      // Create entry
      await store.check('test-key');
      
      // Advance time past TTL (2x refillInterval = 2000ms)
      vi.setSystemTime(Date.now() + 2500);

      // Access should evict and create new bucket
      const result = await store.check('test-key');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // New bucket, 1 consumed

      await store.shutdown();
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entry when exceeding 10,000 keys', async () => {
      const store = new InMemoryStore();

      // Fill to capacity (keep time within TTL)
      for (let i = 0; i < 10_000; i++) {
        await store.check(`key-${i}`);
      }

      // Add one more - should evict key-0 (oldest)
      vi.setSystemTime(Date.now() + 100);
      await store.check('key-10000');

      // Check key-1 first (still exists, not evicted by key-10000 insertion)
      const result1 = await store.check('key-1');
      expect(result1.remaining).toBe(498); // Existing bucket (499 - 1)

      // key-0 was evicted by LRU, re-access creates new bucket
      const result0 = await store.check('key-0');
      expect(result0.remaining).toBe(499); // New bucket (default burst 500 - 1)

      await store.shutdown();
    });
  });

  describe('step-wise interval advancement', () => {
    it('should only add whole intervals worth of tokens', async () => {
      const store = new InMemoryStore({ burst: 10, refillRate: 5, refillInterval: 1000 });

      // Initial check
      await store.check('test-key');
      
      // Advance by 1.5 intervals (1500ms)
      vi.setSystemTime(Date.now() + 1500);

      const result = await store.check('test-key');
      // Should only add 1 interval's worth (5 tokens), not 1.5
      // Initial: 10 tokens, after check: 9, after 1 interval: min(10, 9+5)=10, after check: 9
      expect(result.remaining).toBe(9);

      await store.shutdown();
    });
  });

  describe('clock skew', () => {
    it('should clamp negative elapsed time to 0', async () => {
      const store = new InMemoryStore({ burst: 10, refillRate: 5, refillInterval: 1000 });

      // Create entry at time T
      const result1 = await store.check('test-key');
      expect(result1.remaining).toBe(9);

      // Move time backwards (clock skew)
      vi.setSystemTime(Date.now() - 5000);

      // Should not penalize user - tokens should not go negative
      const result2 = await store.check('test-key');
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(8); // Just decremented, no tokens added

      await store.shutdown();
    });
  });

  describe('shutdown', () => {
    it('should clear all entries on shutdown', async () => {
      const store = new InMemoryStore();

      await store.check('key-1');
      await store.check('key-2');
      await store.check('key-3');

      await store.shutdown();

      // After shutdown, entries should be cleared
      const result = await store.check('key-1');
      expect(result.remaining).toBe(499); // New bucket (default burst 500 - 1)

      await store.shutdown();
    });
  });

  describe('opaque key preservation', () => {
    it('should not normalize keys', async () => {
      const store = new InMemoryStore();

      const result1 = await store.check('UPPERCASE-KEY');
      const result2 = await store.check('lowercase-key');
      const result3 = await store.check('  spaced-key  ');

      expect(result1.remaining).toBe(499);
      expect(result2.remaining).toBe(499);
      expect(result3.remaining).toBe(499);

      await store.shutdown();
    });
  });
});
