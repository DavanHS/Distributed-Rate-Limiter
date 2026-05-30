# @davanhs/rate-limiter-express

Express middleware adapter for the `@davanhs/rate-limiter` distributed token-bucket core.

## Installation

```bash
npm install @davanhs/rate-limiter-express @davanhs/rate-limiter
```

## Quick Start

```ts
import express from 'express';
import { RedisStore } from '@davanhs/rate-limiter';
import { createExpressMiddleware } from '@davanhs/rate-limiter-express';

const app = express();

// 1. Initialize the core store
const store = new RedisStore({ redisUrl: 'redis://localhost:6379' });

// 2. Apply the middleware
app.use(createExpressMiddleware(store, { anonymous: true }));

app.get('/', (req, res) => res.send('Rate limited endpoint'));
```

📚 **[View the full documentation, options, and architecture in the main repository.](https://github.com/davanhs/rate-limiter)**
