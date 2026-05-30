import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHonoMiddleware } from '../src/index.js';
import type { RateLimitMiddleware } from '@davanhs/rate-limiter';

describe('createHonoMiddleware', () => {
  const createMockLimiter = (allowed = true): RateLimitMiddleware => {
    return vi.fn().mockImplementation(async (key: string, next: () => Promise<void>) => {
      if (allowed) {
        await next();
      }
      return {
        allowed,
        headers: {
          'X-RateLimit-Limit': '500',
          'X-RateLimit-Remaining': allowed ? '499' : '0',
          ...(allowed ? {} : { 'Retry-After': '12' })
        },
        body: allowed ? null : {
          error: 'rate_limit_exceeded',
          message: 'Too many requests. Please wait.',
          retryAfter: 12
        }
      };
    });
  };

  it('should use Authorization header as key if present', async () => {
    const limiter = createMockLimiter();
    const app = new Hono();
    app.use('*', createHonoMiddleware(limiter));
    app.get('/', (c) => c.text('ok'));

    const req = new Request('http://localhost/', {
      headers: { 'Authorization': 'Bearer my-token' }
    });
    
    await app.request(req);
    expect(limiter).toHaveBeenCalledWith('Bearer my-token', expect.any(Function));
  });

  it('should return 401 if no Auth header and anonymous is false', async () => {
    const limiter = createMockLimiter();
    const app = new Hono();
    app.use('*', createHonoMiddleware(limiter));
    app.get('/', (c) => c.text('ok'));

    const req = new Request('http://localhost/');
    const res = await app.request(req);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'unauthorized',
      message: 'Authorization header is required.'
    });
    expect(limiter).not.toHaveBeenCalled();
  });

  it('should hash IP+UA if no Auth header and anonymous is true', async () => {
    const limiter = createMockLimiter();
    const app = new Hono();
    app.use('*', createHonoMiddleware(limiter, { anonymous: true }));
    app.get('/', (c) => c.text('ok'));

    const req = new Request('http://localhost/', {
      headers: {
        'x-forwarded-for': '192.168.1.1',
        'user-agent': 'test-agent'
      }
    });
    
    await app.request(req);
    expect(limiter).toHaveBeenCalledWith(expect.any(String), expect.any(Function));
  });

  it('should apply rate limit headers to successful response', async () => {
    const limiter = createMockLimiter();
    const app = new Hono();
    app.use('*', createHonoMiddleware(limiter, { anonymous: true }));
    app.get('/', (c) => c.text('ok'));

    const req = new Request('http://localhost/');
    const res = await app.request(req);

    expect(res.headers.get('x-ratelimit-limit')).toBe('500');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('499');
  });

  it('should return 429 and JSON body when rate limit exceeded', async () => {
    const limiter = createMockLimiter(false);
    const app = new Hono();
    app.use('*', createHonoMiddleware(limiter, { anonymous: true }));
    app.get('/', (c) => c.text('ok'));

    const req = new Request('http://localhost/');
    const res = await app.request(req);

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(await res.json()).toEqual({
      error: 'rate_limit_exceeded',
      message: 'Too many requests. Please wait.',
      retryAfter: 12
    });
  });
});
