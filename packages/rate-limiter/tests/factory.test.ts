import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter } from '../src/factory.js';
import type { RateLimitStore, CheckResult } from '../src/types.js';

describe('createRateLimiter', () => {
  const createMockStore = (
    checkResult: Partial<CheckResult> = {},
  ): RateLimitStore => ({
    check: vi.fn().mockResolvedValue({
      allowed: true,
      limit: 500,
      remaining: 499,
      resetTime: Date.now() + 1000,
      retryAfter: 0,
      ...checkResult,
    }),
    shutdown: vi.fn(),
  });

  describe('allowed requests', () => {
    it('should call next() when request is allowed', async () => {
      const store = createMockStore({ allowed: true });
      const limiter = createRateLimiter(store);
      const next = vi.fn().mockResolvedValue(undefined);

      await limiter('test-key', next);

      expect(next).toHaveBeenCalledOnce();
    });

    it('should return allowed: true with headers', async () => {
      const store = createMockStore({ allowed: true });
      const limiter = createRateLimiter(store);
      const next = vi.fn().mockResolvedValue(undefined);

      const result = await limiter('test-key', next);

      expect(result.allowed).toBe(true);
      expect(result.headers['X-RateLimit-Limit']).toBe('500');
      expect(result.headers['X-RateLimit-Remaining']).toBe('499');
      expect(result.body).toBeNull();
    });

    it('should not include Retry-After header when allowed', async () => {
      const store = createMockStore({ allowed: true });
      const limiter = createRateLimiter(store);
      const next = vi.fn().mockResolvedValue(undefined);

      const result = await limiter('test-key', next);

      expect(result.headers['Retry-After']).toBeUndefined();
    });
  });

  describe('denied requests', () => {
    it('should NOT call next() when request is denied', async () => {
      const store = createMockStore({
        allowed: false,
        remaining: 0,
        retryAfter: 12,
      });
      const limiter = createRateLimiter(store);
      const next = vi.fn();

      await limiter('test-key', next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should return allowed: false with 429 headers and body', async () => {
      const store = createMockStore({
        allowed: false,
        remaining: 0,
        retryAfter: 12,
      });
      const limiter = createRateLimiter(store);
      const next = vi.fn();

      const result = await limiter('test-key', next);

      expect(result.allowed).toBe(false);
      expect(result.headers['X-RateLimit-Limit']).toBe('500');
      expect(result.headers['X-RateLimit-Remaining']).toBe('0');
      expect(result.headers['Retry-After']).toBe('12');
      expect(result.body).toEqual({
        error: 'rate_limit_exceeded',
        message: 'Too many requests. Please wait.',
        retryAfter: 12,
      });
    });
  });

  describe('fail-open safety', () => {
    it('should allow request and call next() when store throws', async () => {
      const store = createMockStore();
      store.check = vi.fn().mockRejectedValue(new Error('Store error'));
      const limiter = createRateLimiter(store);
      const next = vi.fn().mockResolvedValue(undefined);

      const result = await limiter('test-key', next);

      expect(result.allowed).toBe(true);
      expect(next).toHaveBeenCalledOnce();
    });

    it('should return empty headers when failing open', async () => {
      const store = createMockStore();
      store.check = vi.fn().mockRejectedValue(new Error('Store error'));
      const limiter = createRateLimiter(store);
      const next = vi.fn().mockResolvedValue(undefined);

      const result = await limiter('test-key', next);

      expect(result.headers).toEqual({});
      expect(result.body).toBeNull();
    });
  });
});
