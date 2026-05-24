# @davanhs/rate-limiter

Production-grade distributed rate limiting for Bun, Hono, and Fetch-style applications.

- **Token bucket algorithm** — handles bursty + steady traffic
- **Pluggable stores** — in-memory (single node) or Redis (distributed)
- **Framework-agnostic core** — Hono adapter built-in, extensible to any framework
- **Signed cookie identity** — Hono adapter issues tamper-proof opaque client IDs
- **Zero-config defaults** — works out of the box, configurable when you need it
- **Fail-open** — Redis goes down? Your API stays up

## Install

```bash
bun add @davanhs/rate-limiter
```

## Quick Start

### Hono + Redis (Distributed)

```ts
import { Hono } from "hono";
import { createRateLimiter, RedisStore } from "@davanhs/rate-limiter";
import { createHonoMiddleware } from "@davanhs/rate-limiter/hono";

const app = new Hono();

const store = new RedisStore({
  redisUrl: process.env.REDIS_URL!,
  burst: 500,
  refillRate: 50,
  refillInterval: 1000,
});
const limiter = createRateLimiter(store);

app.use("*", createHonoMiddleware(limiter));
app.get("/", (c) => c.text("Hello!"));

app.fire();
```

### Hono + In-Memory (Single Node)

```ts
import { Hono } from "hono";
import { createRateLimiter, InMemoryStore } from "@davanhs/rate-limiter";
import { createHonoMiddleware } from "@davanhs/rate-limiter/hono";

const app = new Hono();

const store = new InMemoryStore();
const limiter = createRateLimiter(store);

app.use("*", createHonoMiddleware(limiter));
```

### Raw Fetch API (Framework-Agnostic)

```ts
import { createRateLimiter, InMemoryStore } from "@davanhs/rate-limiter";

const store = new InMemoryStore();
const limiter = createRateLimiter(store);

async function handler(request: Request) {
  const key = request.headers.get("x-client-id") ?? crypto.randomUUID();

  const response = await limiter(key, () => undefined);
  if (response) return response; // 429

  return new Response("Hello!");
}
```

## Configuration

### Rate Limit Options

| Option | Type | Default | Description |
|---|---|---|---|
| `burst` | `number` | `500` | Maximum token bucket capacity |
| `refillRate` | `number` | `50` | Tokens added per refill interval |
| `refillInterval` | `number` (ms) | `1000` | Milliseconds between refills |
| `redisUrl` | `string` (URL) | — | Redis connection URL (required for `RedisStore`) |

Rate limit options belong to the store. `createRateLimiter(store)` does not accept duplicate rate policy.

### Environment

Set the signing secret yourself. The package only reads it.

```env
REDIS_URL=redis://localhost:6379
RATE_LIMIT_COOKIE_SECRET=replace-with-a-long-random-secret
```

### Hono Cookie Identity

The Hono adapter reads and writes one fixed signed session cookie:

- Env secret: `RATE_LIMIT_COOKIE_SECRET` (required)
- Cookie name: `__rl_id`
- Attributes: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`
- Missing or invalid cookie: new opaque ID is generated and signed
- No IP fallback and no app-provided key resolver in v1

## Stores

### InMemoryStore

Single-node rate limiting with token bucket + hybrid eviction (TTL + LRU at 10,000 keys).

```ts
import { InMemoryStore } from "@davanhs/rate-limiter";

const store = new InMemoryStore();
```

### RedisStore

Distributed rate limiting with atomic Lua script execution.

```ts
import { RedisStore } from "@davanhs/rate-limiter";

const store = new RedisStore({
  redisUrl: "redis://localhost:6379",
  burst: 100,
  refillRate: 10,
  refillInterval: 1000,
});
```

**Features:**
- Atomic token bucket via Lua script (no race conditions)
- `SCRIPT LOAD` / `EVALSHA` with `EVAL` fallback
- Redis `TIME` command for server-clock timestamps, falls back to `Date.now()`
- Key format: `rl:<opaqueKey>` (hash with `tokens` + `lastRefill`, TTL = 2× refill interval)
- Keys are exact opaque values; they are not lowercased, trimmed, or normalized
- Fail-open on runtime errors (logs warning, allows request)
- Throws `RedisLimiterInitError` on startup failure (bad URL, connection refused)

## API Reference

### `createRateLimiter(store, logger?)`

Factory function that returns a `RateLimitMiddleware`:

```ts
type RateLimitMiddleware = (
  key: string,
  next: RateLimitNext
) => Promise<Response | undefined>;
```

- Calls `next()` if the request is allowed
- Returns a `Response` with status 429 if the request is denied

### `CheckResult`

```ts
interface CheckResult {
  allowed: boolean;
  limit: number; // Burst capacity
  remaining: number; // 0 when exhausted
  resetTime: number; // Absolute Unix epoch ms
  retryAfter: number; // Absolute Unix epoch ms (0 when allowed)
}
```

### Response Headers

| Header | Description |
|---|---|
| `X-RateLimit-Limit` | Burst capacity |
| `X-RateLimit-Remaining` | Tokens remaining (0 when exhausted) |
| `Retry-After` | Seconds until retry (0 when allowed) |

### 429 Response Body

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 1747324800000
}
```

## Error Handling

| Error Class | When |
|---|---|
| `RateLimiterError` | Base class for all rate limiter errors |
| `RedisLimiterInitError` | Thrown on RedisStore initialization failure |

**Runtime behavior:**
- Invalid config at init → throws (developer error, catch early)
- Redis connection lost → fail-open (log + allow request)
- Missing or invalid Hono cookie → new signed identity

## Local Development

### Start Redis

```bash
docker compose up -d
```

### Run Tests

```bash
bun test
```

### Run Integration Tests

```bash
REDIS_URL=redis://localhost:6379 bun test
```

### Type Check

```bash
bun run typecheck
```

### Build

```bash
bun run build
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Your App                      │
│  ┌───────────────────────────────────────────┐  │
│  │          Hono Adapter (hono.ts)           │  │
│  │ Reads/signs cookie → passes opaque key    │  │
│  └──────────────────┬────────────────────────┘  │
│                     │                           │
│  ┌──────────────────▼────────────────────────┐  │
│  │       Middleware (middleware.ts)          │  │
│  │       key → store.check → 429 or next()   │  │
│  └──────────────────┬────────────────────────┘  │
│                     │                           │
│  ┌──────────────────┼────────────────────────┐  │
│  │    Store Interface (store.ts)             │  │
│  │  check(key): Promise<CheckResult>         │  │
│  │  ┌──────────────┐  ┌──────────────────┐   │  │
│  │  │ InMemoryStore│  │   RedisStore     │   │  │
│  │  │ (token bucket│  │ (Lua script,     │   │  │
│  │  │  + LRU evict)│  │  EVALSHA/EVAL)   │   │  │
│  │  └──────────────┘  └──────────────────┘   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## License

MIT
