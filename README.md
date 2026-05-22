# @davanhs/rate-limiter

Production-grade distributed rate limiting for Bun, Hono, and Fetch-style applications.

- **Token bucket algorithm** — handles bursty + steady traffic
- **Pluggable stores** — in-memory (single node) or Redis (distributed)
- **Framework-agnostic core** — Hono adapter built-in, extensible to any framework
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

const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
const limiter = createRateLimiter(store, {
  burst: 500,
  refillRate: 50,
  refillInterval: 1000,
});

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
  const req = {
    headers: request.headers,
    ip: request.headers.get("x-forwarded-for") ?? "unknown",
  };

  const response = await limiter(req, () => undefined);
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
| `keyResolver` | `KeyResolver` | IP-based | Custom key resolution function |
| `redisUrl` | `string` (URL) | — | Redis connection URL (required for `RedisStore`) |

### Custom Key Resolver

Rate limit by API key, user ID, session, or anything else:

```ts
const limiter = createRateLimiter(store, {
  keyResolver: (req) => req.headers.get("authorization"),
});
```

If your resolver throws, returns `null`/`undefined`/empty string, the limiter logs a warning and falls back to IP-based resolution. Your API stays protected even when custom key resolution fails.

### Custom IP Extraction (Hono)

```ts
app.use(
  "*",
  createHonoMiddleware(limiter, {
    getIp: (c) => c.req.header("cf-connecting-ip"),
  })
);
```

IP resolution fallback chain: `getIp()` → `x-real-ip` → `cf-connecting-ip` → `x-forwarded-for` (first IP) → `"unknown"`.

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

const store = new RedisStore({ redisUrl: "redis://localhost:6379" });
```

**Features:**
- Atomic token bucket via Lua script (no race conditions)
- `SCRIPT LOAD` / `EVALSHA` with `EVAL` fallback
- Redis `TIME` command for server-clock timestamps, falls back to `Date.now()`
- Key format: `rl:<normalizedKey>` (hash with `tokens` + `lastRefill`, TTL = 2× refill interval)
- Fail-open on runtime errors (logs warning, allows request)
- Throws `RedisLimiterInitError` on startup failure (bad URL, connection refused)

**Inject your own Redis client:**

```ts
import Redis from "ioredis";
import { RedisStore } from "@davanhs/rate-limiter";

const client = new Redis("redis://localhost:6379");
const store = new RedisStore({ redisUrl: "redis://localhost:6379" }, client);
```

## API Reference

### `createRateLimiter(store, options?, logger?)`

Factory function that returns a `RateLimitMiddleware`:

```ts
type RateLimitMiddleware = (
  req: RateLimitRequest,
  next: RateLimitNext
) => Promise<Response | undefined>;
```

- Returns `undefined` if the request is allowed (call `next()`)
- Returns a `Response` with status 429 if the request is denied

### `RateLimitRequest`

```ts
interface RateLimitRequest {
  headers: HeaderSource; // Headers, { get(name) }, or Record<string, string | string[] | undefined>
  ip: string;
}
```

### `CheckResult`

```ts
interface CheckResult {
  allowed: boolean;
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
| `KeyResolverError` | Defined for extensibility (fallback used instead of throwing) |
| `RedisLimiterInitError` | Thrown on RedisStore initialization failure |

**Runtime behavior:**
- Invalid config at init → throws (developer error, catch early)
- Redis connection lost → fail-open (log + allow request)
- Key resolver throws → fallback to IP + warn

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
│  │  Converts Hono Context → RateLimitRequest │  │
│  └──────────────────┬────────────────────────┘  │
│                     │                           │
│  ┌──────────────────▼────────────────────────┐  │
│  │       Middleware (middleware.ts)          │  │
│  │  resolveKey → store.check → 429 or next() │  │
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
