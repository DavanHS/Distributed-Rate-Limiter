# @davanhs/rate-limiter

A production-grade, distributed rate-limiting library for modern web frameworks.

## Features

- **Framework-agnostic core** — adapters for Hono, Express, and any Fetch-compatible server
- **Redis support with Lua** — atomic token bucket operations via EVALSHA/EVAL with NOSCRIPT fallback
- **InMemory support with LRU** — bounded local store with lazy TTL eviction (default 10,000 keys)
- **Anonymous IP+UA hashing** — SHA-256 of `ip-user-agent` for unauthenticated clients
- **Fail-open behavior** — configurable; defaults to allowing requests on store errors
- **Token bucket algorithm** — handles bursty and steady traffic with configurable refill rates
- **Step-wise interval advancement** — fractional time preservation for precise token accounting

## Installation

```bash
pnpm add @davanhs/rate-limiter
```

### Framework adapters

```bash
# Hono
pnpm add @davanhs/rate-limiter-hono

# Express
pnpm add @davanhs/rate-limiter-express
```

## Quick Start

### Hono + Redis (Distributed)

The Hono adapter accepts a pre-instantiated `RateLimitMiddleware` from `createRateLimiter`.

```ts
import { Hono } from 'hono';
import { createRateLimiter, RedisStore } from '@davanhs/rate-limiter';
import { createHonoMiddleware } from '@davanhs/rate-limiter-hono';

const app = new Hono();

const store = new RedisStore({
  redisUrl: process.env.REDIS_URL!,
  burst: 500,
  refillRate: 50,
  refillInterval: 1000,
});
const limiter = createRateLimiter(store);

app.use('*', createHonoMiddleware(limiter));
app.get('/', (c) => c.text('Hello!'));

export default app;
```

### Express + Redis (Distributed)

The Express adapter accepts a `RateLimitStore` directly (bypassing the middleware factory to avoid the `next()` lifecycle issue in Express v4).

```ts
import express from 'express';
import { RedisStore } from '@davanhs/rate-limiter';
import { createExpressMiddleware } from '@davanhs/rate-limiter-express';

const app = express();

const store = new RedisStore({
  redisUrl: process.env.REDIS_URL!,
  burst: 500,
  refillRate: 50,
  refillInterval: 1000,
});

app.use(createExpressMiddleware(store));
app.get('/', (req, res) => res.send('Hello!'));

app.listen(3000);
```

### Hono + InMemory (Single Node)

```ts
import { Hono } from 'hono';
import { createRateLimiter, InMemoryStore } from '@davanhs/rate-limiter';
import { createHonoMiddleware } from '@davanhs/rate-limiter-hono';

const app = new Hono();

const store = new InMemoryStore();
const limiter = createRateLimiter(store);

app.use('*', createHonoMiddleware(limiter));
app.get('/', (c) => c.text('Hello!'));
```

## Options Reference

### Token Bucket Options (store-level)

| Option | Type | Default | Description |
|---|---|---|---|
| `burst` | `number` | `500` | Maximum token bucket capacity |
| `refillRate` | `number` | `50` | Tokens added per refill interval |
| `refillInterval` | `number` (ms) | `1000` | Milliseconds between refills |

```ts
// InMemoryStore
new InMemoryStore({ burst: 1000, refillRate: 100, refillInterval: 2000 });

// RedisStore
new RedisStore({
  redisUrl: 'redis://localhost:6379',
  burst: 1000,
  refillRate: 100,
  refillInterval: 2000,
});
```

### Adapter Options

| Option | Type | Default | Description |
|---|---|---|---|
| `anonymous` | `boolean` | `false` | Allow unauthenticated requests via IP+UA hash |

When `anonymous: false` (default), requests without an `Authorization` header receive a `401 Unauthorized` response.

When `anonymous: true`, requests without an `Authorization` header are keyed by a SHA-256 hash of `${ip}-${user-agent}`.

```ts
createHonoMiddleware(limiter, { anonymous: true });
createExpressMiddleware(store, { anonymous: true });
```

## Key Resolution Hierarchy

1. **Authorization header** — used as-is when present
2. **Anonymous fallback** — if `anonymous: true`, SHA-256 hash of `ip-user-agent`
3. **401 rejection** — if `anonymous: false` and no Authorization header

## Stores

### InMemoryStore

Single-node rate limiting with token bucket and hybrid eviction (lazy TTL + LRU at 10,000 keys).

```ts
import { InMemoryStore } from '@davanhs/rate-limiter';

const store = new InMemoryStore({ burst: 100, refillRate: 10, refillInterval: 1000 });
```

### RedisStore

Distributed rate limiting with atomic Lua script execution.

```ts
import { RedisStore } from '@davanhs/rate-limiter';

const store = new RedisStore({
  redisUrl: 'redis://localhost:6379',
  burst: 100,
  refillRate: 10,
  refillInterval: 1000,
});
```

- Atomic token bucket via Lua script (no race conditions)
- `SCRIPT LOAD` / `EVALSHA` with `EVAL` fallback on NOSCRIPT
- Redis `TIME` command for server-clock timestamps, falls back to `Date.now()`
- Key format: `rl:<key>` (hash with `tokens` + `lastRefill`, TTL = 2× refill interval)
- Fail-open on runtime errors (logs warning, allows request)
- Throws `RedisLimiterInitError` on startup failure (bad URL, connection refused)

## Response Headers

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Burst capacity |
| `X-RateLimit-Remaining` | Tokens remaining (0 when exhausted) |
| `Retry-After` | Seconds until retry (absent when allowed) |

### 429 Response Body

```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Please wait.",
  "retryAfter": 12
}
```

## Error Handling

| Error Class | When |
|---|---|
| `RateLimiterError` | Base class for all rate limiter errors |
| `RedisLimiterInitError` | Thrown on RedisStore initialization failure |

**Runtime behavior:**
- Invalid config at init → throws (developer error, catch early)
- Redis connection lost → fail-open (logs warning, allows request)
- Express adapter fail-open → calls `next()` on store errors

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Your App                      │
│  ┌──────────────────┐ ┌──────────────────────┐  │
│  │   Hono Adapter   │ │   Express Adapter    │  │
│  │ (middleware)     │ │ (store directly)     │  │
│  └────────┬─────────┘ └──────────┬───────────┘  │
│           │                      │              │
│  ┌────────▼──────────────────────▼───────────┐  │
│  │         RateLimitStore Interface          │  │
│  │         check(key): Promise<CheckResult>  │  │
│  │  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ InMemoryStore│  │   RedisStore     │   │  │
│  │  │ (token bucket│  │ (Lua script,     │   │  │
│  │  │  + LRU evict)│  │  EVALSHA/EVAL)   │   │  │
│  │  └──────────────┘  └──────────────────┘   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## Local Development

```bash
# Install dependencies
pnpm install

# Type check all packages
pnpm -r typecheck

# Run tests
pnpm test

# Start Redis (for integration tests)
docker compose up -d
REDIS_URL=redis://localhost:6379 pnpm test

# Build all packages
pnpm -r build
```

## License

MIT
