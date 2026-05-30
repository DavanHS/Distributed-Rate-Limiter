# @davanhs/rate-limiter-hono

Hono middleware adapter for the `@davanhs/rate-limiter` distributed token-bucket core.

## Installation

```bash
npm install @davanhs/rate-limiter-hono @davanhs/rate-limiter
```

## Quick Start

```ts
import { Hono } from 'hono';
import { createRateLimiter, RedisStore } from '@davanhs/rate-limiter';
import { createHonoMiddleware } from '@davanhs/rate-limiter-hono';

const app = new Hono();

// 1. Initialize the core store and limiter
const store = new RedisStore({ redisUrl: 'redis://localhost:6379' });
const limiter = createRateLimiter(store);

// 2. Apply the middleware
app.use('*', createHonoMiddleware(limiter, { anonymous: true }));

app.get('/', (c) => c.text('Rate limited endpoint'));
```

📚 **[View the full documentation, options, and architecture in the main repository.](https://github.com/davanhs/rate-limiter)**
