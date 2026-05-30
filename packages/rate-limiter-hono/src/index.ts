import { createHash } from 'node:crypto';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import type { RateLimitMiddleware } from '@davanhs/rate-limiter';

export const HonoMiddlewareOptionsSchema = z.object({
  anonymous: z.boolean().default(false),
});

export type HonoMiddlewareOptions = z.infer<typeof HonoMiddlewareOptionsSchema>;

export function createHonoMiddleware(
  limiter: RateLimitMiddleware,
  options?: Partial<HonoMiddlewareOptions>,
) {
  const config = HonoMiddlewareOptionsSchema.parse(options ?? {});

  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('authorization');

    let key: string;

    if (authHeader) {
      key = authHeader;
    } else {
      if (!config.anonymous) {
        return c.json(
          { error: 'unauthorized', message: 'Authorization header is required.' },
          401,
        );
      }

      const ip = c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown';
      const ua = c.req.header('user-agent') || 'unknown';

      key = createHash('sha256').update(`${ip}-${ua}`).digest('hex');
    }

    const response = await limiter(key, async () => {
      await next();
    });

    const headers = response.headers;
    for (const key of Object.keys(headers)) {
      c.header(key, headers[key]);
    }

    if (!response.allowed) {
      return c.json(response.body ?? {}, 429);
    }
  };
}
