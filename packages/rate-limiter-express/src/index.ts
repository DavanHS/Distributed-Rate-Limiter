import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getRateLimitDetails } from '@davanhs/rate-limiter';
import type { RateLimitStore } from '@davanhs/rate-limiter';

export const ExpressMiddlewareOptionsSchema = z.object({
  anonymous: z.boolean().default(false),
});

export type ExpressMiddlewareOptions = z.infer<typeof ExpressMiddlewareOptionsSchema>;

export function createExpressMiddleware(
  store: RateLimitStore,
  options?: Partial<ExpressMiddlewareOptions>,
) {
  const config = ExpressMiddlewareOptionsSchema.parse(options ?? {});

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authHeader = req.headers.authorization;
      let key: string;

      if (authHeader) {
        key = authHeader;
      } else {
        if (!config.anonymous) {
          res.status(401).json({ error: 'unauthorized', message: 'Authorization header is required.' });
          return;
        }

        const ip = req.ip || 'unknown';
        const ua = req.get('user-agent') || 'unknown';
        
        key = createHash('sha256').update(`${ip}-${ua}`).digest('hex');
      }

      const result = await store.check(key);
      const details = getRateLimitDetails(result);

      for (const [k, v] of Object.entries(details.headers)) {
        res.setHeader(k, v);
      }

      if (result.allowed) {
        next();
      } else {
        res.status(429).json(details.body);
      }
    } catch (error) {
      next();
    }
  };
}
