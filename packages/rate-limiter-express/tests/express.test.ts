import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createExpressMiddleware } from '../src/index.js';
import type { RateLimitStore, CheckResult } from '@davanhs/rate-limiter';

describe('createExpressMiddleware', () => {
  const createMockStore = (allowed = true): RateLimitStore => {
    return {
      check: vi.fn().mockResolvedValue({
        allowed,
        limit: 500,
        remaining: allowed ? 499 : 0,
        resetTime: Date.now() + 12000,
        retryAfter: allowed ? 0 : 12,
      } satisfies CheckResult),
      shutdown: vi.fn(),
    };
  };

  it('should use Authorization header as key if present', async () => {
    const store = createMockStore();
    const app = express();
    app.use(createExpressMiddleware(store));
    app.get('/', (req, res) => { res.send('ok'); });

    await request(app)
      .get('/')
      .set('Authorization', 'Bearer my-express-token')
      .expect(200);

    expect(store.check).toHaveBeenCalledWith('Bearer my-express-token');
  });

  it('should return 401 if no Auth header and anonymous is false', async () => {
    const store = createMockStore();
    const app = express();
    app.use(createExpressMiddleware(store));
    app.get('/', (req, res) => { res.send('ok'); });

    const res = await request(app).get('/');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'unauthorized',
      message: 'Authorization header is required.'
    });
    expect(store.check).not.toHaveBeenCalled();
  });

  it('should hash IP+UA if no Auth header and anonymous is true', async () => {
    const store = createMockStore();
    const app = express();
    app.set('trust proxy', true);
    app.use(createExpressMiddleware(store, { anonymous: true }));
    app.get('/', (req, res) => { res.send('ok'); });

    await request(app)
      .get('/')
      .set('x-forwarded-for', '192.168.1.1')
      .set('user-agent', 'test-agent')
      .expect(200);

    expect(store.check).toHaveBeenCalledWith(expect.any(String));
  });

  it('should apply rate limit headers to successful response', async () => {
    const store = createMockStore();
    const app = express();
    app.use(createExpressMiddleware(store, { anonymous: true }));
    app.get('/', (req, res) => { res.send('ok'); });

    const res = await request(app).get('/');

    expect(res.headers['x-ratelimit-limit']).toBe('500');
    expect(res.headers['x-ratelimit-remaining']).toBe('499');
  });

  it('should return 429 and JSON body when rate limit exceeded', async () => {
    const store = createMockStore(false);
    const app = express();
    app.use(createExpressMiddleware(store, { anonymous: true }));
    app.get('/', (req, res) => { res.send('ok'); });

    const res = await request(app).get('/');

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('12');
    expect(res.body).toEqual({
      error: 'rate_limit_exceeded',
      message: 'Too many requests. Please wait.',
      retryAfter: 12
    });
  });

  it('should fail open on store error', async () => {
    const store = {
      check: vi.fn().mockRejectedValue(new Error('Store unavailable')),
      shutdown: vi.fn(),
    };
    const app = express();
    app.use(createExpressMiddleware(store, { anonymous: true }));
    app.get('/', (req, res) => { res.send('ok'); });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('ok');
  });
});
