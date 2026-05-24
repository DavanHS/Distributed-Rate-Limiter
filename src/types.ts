import { z } from "zod";

export type CheckResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number;
  retryAfter: number;
};

export type MaybePromise<T> = T | Promise<T>;

export type RateLimitNext = () => MaybePromise<Response | undefined>;

export type RateLimitMiddleware = (
  key: string,
  next: RateLimitNext,
) => Promise<Response | undefined>;

export const TokenBucketOptionsSchema = z.object({
  burst: z.number().int().positive().default(500),
  refillRate: z.number().int().positive().default(50),
  refillInterval: z.number().int().positive().default(1000),
});

export const RedisStoreOptionsSchema = TokenBucketOptionsSchema.extend({
  redisUrl: z.url(),
});

export type TokenBucketOptionsInput = z.input<typeof TokenBucketOptionsSchema>;

export type TokenBucketOptions = z.output<typeof TokenBucketOptionsSchema>;

export type RedisStoreOptionsInput = z.input<typeof RedisStoreOptionsSchema>;

export type RedisStoreOptions = z.output<typeof RedisStoreOptionsSchema>;
