import { describe, it, expect } from 'vitest';
import { getRateLimitDetails } from '../src/utils.js';

describe('getRateLimitDetails', () => {
  it('returns headers without Retry-After when allowed', () => {
    const result = getRateLimitDetails({
      allowed: true,
      limit: 500,
      remaining: 499,
      resetTime: Date.now(),
      retryAfter: 0,
    });

    expect(result.headers['X-RateLimit-Limit']).toBe('500');
    expect(result.headers['X-RateLimit-Remaining']).toBe('499');
    expect(result.headers['Retry-After']).toBeUndefined();
    expect(result.body).toBeNull();
  });

  it('returns headers with Retry-After and body when denied', () => {
    const result = getRateLimitDetails({
      allowed: false,
      limit: 500,
      remaining: 0,
      resetTime: Date.now(),
      retryAfter: 12,
    });

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
