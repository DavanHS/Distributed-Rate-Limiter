import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisStore } from '../src/redis-store.js';

// Mock ioredis module
const mockRedis = {
  script: vi.fn(),
  evalsha: vi.fn(),
  eval: vi.fn(),
  time: vi.fn(),
  quit: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => mockRedis),
}));

const TEST_OPTIONS = { redisUrl: 'redis://localhost:6379' };

describe('RedisStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock behavior
    mockRedis.script.mockResolvedValue('mock-sha-hash');
    mockRedis.evalsha.mockResolvedValue([1, 499, 0]);
    mockRedis.eval.mockResolvedValue([1, 499, 0]);
    mockRedis.time.mockResolvedValue([Math.floor(Date.now() / 1000), 0]);
    mockRedis.quit.mockResolvedValue(undefined);
  });

  describe('basic rate limiting', () => {
    it('should load Lua script on init', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      await store.check('test-key');

      expect(mockRedis.script).toHaveBeenCalledWith('load', expect.stringContaining('HGETALL'));
    });

    it('should call evalsha with script hash and args', async () => {
      const store = new RedisStore(TEST_OPTIONS);

      // Wait for script to load
      await vi.waitFor(() => {
        expect(mockRedis.script).toHaveBeenCalled();
      });

      mockRedis.evalsha.mockResolvedValue([1, 499, 0]);
      const result = await store.check('test-key');

      expect(mockRedis.evalsha).toHaveBeenCalledWith(
        'mock-sha-hash',
        1,
        'rl:test-key',
        expect.any(String), // burst
        expect.any(String), // refillRate
        expect.any(String), // refillInterval
        expect.any(String), // now
      );
    });

    it('should return CheckResult from evalsha response', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      mockRedis.evalsha.mockResolvedValue([1, 499, 0]);

      const result = await store.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(499);
      expect(result.limit).toBe(500);
      expect(result.retryAfter).toBe(0);
    });
  });

  describe('NOSCRIPT fallback', () => {
    it('should fallback to EVAL when NOSCRIPT error thrown', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      mockRedis.evalsha.mockRejectedValue(new Error('NOSCRIPT No matching script'));
      mockRedis.eval.mockResolvedValue([1, 499, 0]);

      const result = await store.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(499);
      expect(mockRedis.eval).toHaveBeenCalled();
    });

    it('should reload script after NOSCRIPT fallback', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      mockRedis.evalsha.mockRejectedValue(new Error('NOSCRIPT No matching script'));
      mockRedis.eval.mockResolvedValue([1, 499, 0]);

      await store.check('test-key');

      // Should attempt to reload script (fire-and-forget)
      expect(mockRedis.script).toHaveBeenCalledTimes(2);
    });
  });

  describe('fail-open behavior', () => {
    it('should allow request when Redis errors and failOpen is true', async () => {
      const store = new RedisStore({ ...TEST_OPTIONS, failOpen: true });
      mockRedis.evalsha.mockRejectedValue(new Error('Redis connection lost'));

      const result = await store.check('test-key');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(500); // Full bucket
      expect(result.retryAfter).toBe(0);
    });
  });

  describe('fail-closed behavior', () => {
    it('should deny request when Redis errors and failOpen is false', async () => {
      const store = new RedisStore({ ...TEST_OPTIONS, failOpen: false });
      mockRedis.evalsha.mockRejectedValue(new Error('Redis connection lost'));

      const result = await store.check('test-key');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('rate limited response', () => {
    it('should return denied result when evalsha returns denied', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      // [allowed, tokens, retryAfter]
      mockRedis.evalsha.mockResolvedValue([0, 0, 12]);

      const result = await store.check('test-key');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBe(12);
    });
  });

  describe('clock synchronization', () => {
    it('should fetch time from Redis TIME command', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      const nowSeconds = Math.floor(Date.now() / 1000);
      mockRedis.time.mockResolvedValue([nowSeconds, 0]);
      mockRedis.evalsha.mockResolvedValue([1, 499, 0]);

      await store.check('test-key');

      expect(mockRedis.time).toHaveBeenCalled();
    });

    it('should fallback to Date.now() if TIME fails', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      mockRedis.time.mockRejectedValue(new Error('TIME failed'));
      mockRedis.evalsha.mockResolvedValue([1, 499, 0]);

      const result = await store.check('test-key');

      // Should still work - using Date.now() as fallback
      expect(result.allowed).toBe(true);
    });
  });

  describe('shutdown', () => {
    it('should call quit on Redis client', async () => {
      const store = new RedisStore(TEST_OPTIONS);
      await store.shutdown();

      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });
});
